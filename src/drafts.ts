import { randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult, SessionEntry } from "@earendil-works/pi-coding-agent";

export const DRAFTS_TYPE = "inmemory.drafts";
export const INSTRUCTION_TYPE = "inmemory.instruction";

export interface Draft {
  id: string;
  text: string;
  images?: ImageContent[];
  kind: "submission" | "steer" | "followUp";
  beforeEntryId: string | null;
}

interface DraftState {
  version: 1;
  items: Draft[];
  delivered: string[];
  blockedSubmissionId?: string;
  restored?: { ids: string[]; images?: ImageContent[]; text?: string };
  editorDraft?: string;
}

/** Drafts are session metadata, never executable model instructions until explicitly delivered. */
export class Drafts {
  private state: DraftState = { version: 1, items: [], delivered: [] };
  private readonly pi: ExtensionAPI;
  constructor(pi: ExtensionAPI) { this.pi = pi; }

  load(entries: SessionEntry[]): void {
    const entry = entries.findLast((item) => item.type === "custom" && item.customType === DRAFTS_TYPE);
    const state = entry?.type === "custom" ? entry.data as DraftState | undefined : undefined;
    this.state = state?.version === 1 ? structuredClone(state) : { version: 1, items: [], delivered: [] };
  }

  private save(): void { this.pi.appendEntry(DRAFTS_TYPE, structuredClone(this.state)); }

  get submission(): Draft | undefined { return this.state.items.findLast((item) => item.kind === "submission"); }
  get blockedSubmission(): Draft | undefined { return this.state.items.find((item) => item.id === this.state.blockedSubmissionId); }

  capture(event: InputEvent, ctx: ExtensionContext, ready: boolean, pendingReason?: string): InputEventResult {
    // The user is submitting the editor's actual contents, including any IDE context.
    delete this.state.editorDraft;
    const restored = ctx.isIdle() ? this.state.restored : undefined;
    const images = event.images?.length ? event.images : restored?.images;
    if (restored) {
      this.state.items = this.state.items.filter((item) => !restored.ids.includes(item.id));
      delete this.state.restored;
    }
    const draft: Draft = { id: randomUUID(), text: event.text, images: images ? structuredClone(images) : undefined,
      kind: ready && ctx.isIdle() ? "submission" : event.streamingBehavior ?? "steer", beforeEntryId: ctx.sessionManager.getLeafId() };
    this.state.items.push(draft);
    this.save();
    if (!ready || !ctx.isIdle()) {
      ctx.ui.notify(ready ? "The additional instruction is saved and will wait for a complete tool boundary in the current task."
        : `The instruction is preserved. The task has not started.\n${pendingReason ?? "Resolve the workspace state first. The instruction will then be restored to the input."}`, ready ? "info" : "warning");
      return { action: "handled" };
    }
    return images ? { action: "transform", text: event.text, images } : { action: "continue" };
  }

  submitted(id: string): void {
    this.state.items = this.state.items.filter((item) => item.id !== id);
    delete this.state.blockedSubmissionId;
    this.save();
  }

  blockSubmission(id: string): void { this.state.blockedSubmissionId = id; this.save(); }

  nextInstruction(entries: SessionEntry[], toolsPending: boolean): Draft | undefined {
    const scheduled = new Set(entries.flatMap((entry) => entry.type === "custom_message" && entry.customType === INSTRUCTION_TYPE
      ? [(entry.details as { draftId?: string } | undefined)?.draftId] : []));
    return this.state.items.find((item) => item.kind !== "submission" && !scheduled.has(item.id) &&
      (item.kind === "steer" || !toolsPending));
  }

  acceptInstructions(entries: SessionEntry[]): void {
    const ids = new Set(entries.flatMap((entry) => entry.type === "custom_message" && entry.customType === INSTRUCTION_TYPE
      ? [(entry.details as { draftId?: string } | undefined)?.draftId] : []));
    const delivered = this.state.items.filter((item) => ids.has(item.id));
    if (!delivered.length) return;
    this.state.delivered.push(...delivered.map((item) => item.id));
    this.state.items = this.state.items.filter((item) => !ids.has(item.id));
    this.save();
  }

  canDeliver(id: string | undefined): boolean {
    return !!id && (this.state.delivered.includes(id) || this.state.items.some((item) => item.id === id && item.kind !== "submission"));
  }

  stage(text: string, ctx: ExtensionContext): void {
    const existing = ctx.ui.getEditorText();
    this.state.editorDraft = existing ? `${existing}\n\n${text}` : text;
    this.save();
    ctx.ui.setEditorText(this.state.editorDraft);
  }

  consumeEditorDraft(): void {
    if (this.state.editorDraft === undefined) return;
    delete this.state.editorDraft;
    delete this.state.restored;
    this.save();
  }

  restore(ctx: ExtensionContext): void {
    delete this.state.blockedSubmissionId;
    if (!this.state.items.length && this.state.editorDraft === undefined) return;
    const existing = ctx.ui.getEditorText() || this.state.editorDraft || "";
    const previous = this.state.restored;
    const previouslyRendered = previous?.text && (existing === previous.text || existing.startsWith(`${previous.text}\n\n`));
    const missing = this.state.items.filter((item) => !previouslyRendered || !previous.ids.includes(item.id));
    const text = [...missing.map((item) => item.text), existing].filter(Boolean).join("\n\n");
    this.state.restored = { ids: this.state.items.map((item) => item.id),
      images: this.state.items.flatMap((item) => item.images ?? []), text };
    this.state.editorDraft = text;
    this.save();
    ctx.ui.setEditorText(text);
    ctx.ui.notify(`The pending instruction is back in the input${this.state.restored.images?.length ? ` with ${this.state.restored.images.length} attachments to resend` : ""}. Send it to start a new task.`, "info");
  }
}
