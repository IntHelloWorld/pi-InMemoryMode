import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BeforeAgentStartUserEvent, BoundaryResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { mountConfig } from "./files.ts";
import { preserveTaskCache, type CacheAnchor } from "./anthropic-cache.ts";
import { checkpointEntry, completedOmissions, estimatedTokens, project, STATE_TYPE, workspaceMessage } from "./projection.ts";
import { Store, type Transaction } from "./store.ts";
import { errorText, type Checkpoint, type Omission, type TaskState } from "./types.ts";
import { Workspace } from "./workspace.ts";
import type { SessionTreeOpenEvent } from "./tree-api.ts";
import { selectableTree, visibleLeaf } from "./tree-view.ts";
import { sessionType } from "./session-list.ts";
import { EXTERNAL_CHANGE_TYPE, EXTERNAL_CHOICE, externalChangeSummary, fileChanges } from "./external-changes.ts";
import { Drafts, INSTRUCTION_TYPE, type Draft } from "./drafts.ts";

interface TreeTarget { checkpoint: Checkpoint; leafId: string | null }
interface PreparedTree extends TreeTarget { transaction: Transaction }

function sameRecoveryState(left: Checkpoint, right: Checkpoint): boolean {
  const state = (checkpoint: Checkpoint) => ({
    sessionId: checkpoint.sessionId, config: checkpoint.config,
    workingId: checkpoint.workingId, baselineId: checkpoint.baselineId,
    task: checkpoint.task, omissions: checkpoint.omissions, enabled: checkpoint.enabled, pendingExternal: checkpoint.pendingExternal,
    externalSnapshotId: checkpoint.externalSnapshotId,
  });
  return JSON.stringify(state(left)) === JSON.stringify(state(right));
}

export class Controller {
  workspace?: Workspace;
  task?: TaskState;
  omissions: Omission[] = [];
  private prepared?: PreparedTree;
  private blocked?: string;
  private lastOutcome: "completed" | "aborted" | "error" = "error";
  private lastCheckpoint?: Checkpoint;
  private cacheUsage?: { input: number; cacheRead: number; cacheWrite: number; provider: string; model: string };
  private cacheAnchor?: CacheAnchor;
  private memorySession = false;
  private submissionNavigation?: { leafId: string; moved: boolean };
  private starting?: Draft;
  private runStarted = false;
  private readonly drafts: Drafts;

  readonly pi: ExtensionAPI;
  constructor(pi: ExtensionAPI) { this.pi = pi; this.drafts = new Drafts(pi); }

  get enabled(): boolean { return this.memorySession; }

  stageIdeText(text: string, ctx: ExtensionContext): void { this.drafts.stage(text, ctx); }

  /** Manual inspection records a pending decision without accepting disk content. */
  async checkExternal(ctx: ExtensionContext): Promise<void> {
    if (!ctx.isIdle()) throw new Error("Wait for the task to finish before checking files.");
    const workspace = this.workspace;
    if (!workspace?.working) throw new Error("No usable directory is mounted.");
    await workspace.queue.run(async () => {
      if (workspace.mode !== "ready" && !workspace.externalChange) workspace.assertReady();
      const disk = await workspace.disk();
      if (disk.id !== workspace.working.id || workspace.externalChange) {
        await workspace.store.saveSnapshot(disk);
        workspace.recoveryBackupId = disk.id;
        workspace.externalSnapshotId = disk.id;
        workspace.externalChange = true;
        workspace.mode = "needs-recovery";
        workspace.failure = ["External changes detected; they have not been accepted into working memory.", externalChangeSummary(workspace.working, disk), EXTERNAL_CHOICE].join("\n\n");
        await this.save(ctx, "position");
      }
      this.status(ctx);
    });
  }

  input(event: InputEvent, ctx: ExtensionContext): InputEventResult {
    if (!this.enabled) { this.drafts.consumeEditorDraft(); return { action: "continue" }; }
    return this.drafts.capture(event, ctx, this.workspace?.mode === "ready", this.workspace?.failure ?? this.blocked);
  }

  prepare(event: BeforeAgentStartUserEvent): void {
    if (!this.enabled) return;
    this.starting = this.drafts.submission;
    if (!this.starting) throw new Error(`Pending instruction was not saved: ${event.prompt.slice(0, 40)}`);
    this.runStarted = false;
  }

  stop(error: unknown, ctx: ExtensionContext): void {
    const message = errorText(error);
    const repeated = this.blocked === message;
    this.blocked = message;
    if (!this.runStarted && this.starting) this.drafts.blockSubmission(this.starting.id);
    if (this.runStarted && this.task?.status === "running") {
      this.task.status = "incomplete";
      this.task.outcome = "aborted";
      if (this.workspace?.externalChange) this.task.interruption = "external-change";
    }
    if (this.workspace) {
      this.workspace.mode = "needs-recovery";
      this.workspace.failure = this.blocked;
    }
    ctx.abort();
    if (!repeated) {
      const externalChange = this.workspace?.externalChange;
      const progress = this.starting && !this.runStarted ? "The instruction is preserved. The task has not started."
        : this.runStarted ? "The task was interrupted and is incomplete." : undefined;
      ctx.ui.notify([
        externalChange ? "InMemory: Waiting for an external-change decision" : "InMemory: Task stopped",
        progress,
        this.blocked,
      ].filter(Boolean).join("\n\n"), externalChange ? "warning" : "error");
    }
    this.status(ctx);
  }

  status(ctx: ExtensionContext): void {
    const workspace = this.workspace;
    ctx.ui.setStatus("inmemory", this.memorySession
      ? `InMemory ${workspace?.mode ?? "needs-recovery"} · ${Object.keys(workspace?.working?.manifest.files ?? {}).length} files` : undefined);
  }

  async save(ctx: ExtensionContext, kind: Checkpoint["kind"], anchorId: string | null = null): Promise<Checkpoint> {
    const workspace = this.workspace!;
    const checkpoint: Checkpoint = {
      version: 1, id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), anchorId,
      config: workspace.config, workingId: workspace.working?.id ?? this.lastCheckpoint!.workingId,
      baselineId: workspace.baseline?.id ?? this.lastCheckpoint!.baselineId,
      task: this.task ? structuredClone(this.task) : undefined, omissions: structuredClone(this.omissions),
      enabled: true, kind, ...(workspace.mode === "needs-recovery" ? { pendingExternal: true } : {}),
      ...(workspace.mode === "needs-recovery" && workspace.externalSnapshotId ? { externalSnapshotId: workspace.externalSnapshotId } : {}),
    };
    await workspace.store.saveCheckpoint(checkpoint);
    this.pi.appendEntry(STATE_TYPE, checkpoint);
    this.lastCheckpoint = checkpoint;
    await workspace.finishTransactions();
    this.status(ctx);
    return checkpoint;
  }

  /** Called under the workspace lock after tool results have reached the transcript. */
  private async recordInterruption(ctx: ExtensionContext): Promise<void> {
    const workspace = this.workspace!;
    if (!workspace.working || !workspace.baseline) return;
    const report = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    const kind = this.task?.status === "incomplete" ? "interrupted" : "position";
    const checkpoint = await this.save(ctx, kind, report?.id ?? null);
    if (checkpoint.task?.status === "incomplete") {
      this.pi.setLabel(ctx.sessionManager.getLeafId()!, "InMemory: Task incomplete");
    }
  }

  /** Exact report anchors can have metadata appended after the selected report itself. */
  resolve(ctx: ExtensionContext, leafId: string | null, strict = true): Checkpoint | undefined {
    if (!leafId) return undefined;
    const all = ctx.sessionManager.getEntries();
    const records = all.filter(checkpointEntry).filter((entry) => entry.data?.sessionId === ctx.sessionManager.getSessionId());
    const indexed = new Map<string, Checkpoint>();
    for (const entry of records) {
      const checkpoint = entry.data!;
      if (checkpoint.anchorId && ["settled", "turn", "compaction"].includes(checkpoint.kind)) indexed.set(checkpoint.anchorId, checkpoint);
    }
    for (const entry of ctx.sessionManager.getBranch(leafId).reverse()) {
      if (checkpointEntry(entry) && entry.data!.sessionId === ctx.sessionManager.getSessionId()) return entry.data;
      const exact = indexed.get(entry.id);
      if (exact) return exact;
      if (strict && entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
        // An unsupported intermediate model/tool node must not silently inherit an older version.
        throw new Error("This node has no stable checkpoint. Select a task report or instruction with an InMemory label.");
      }
    }
    return undefined;
  }

  async initialize(ctx: ExtensionContext): Promise<void> {
    const previous = this.workspace;
    if (previous) await previous.queue.run(() => previous.ownership.release());
    this.workspace = undefined;
    this.task = undefined;
    this.omissions = [];
    this.blocked = undefined;
    this.prepared = undefined;
    this.submissionNavigation = undefined;
    this.starting = undefined;
    this.runStarted = false;
    this.drafts.load(ctx.sessionManager.getBranch());
    this.memorySession = sessionType(ctx.sessionManager.getEntries()) === "inmemory";
    if (!this.memorySession) { this.lastCheckpoint = undefined; this.drafts.restore(ctx); this.status(ctx); return; }
    const selected = this.resolve(ctx, ctx.sessionManager.getLeafId(), false);
    const checkpoint = selected ?? ctx.sessionManager.getEntries().filter(checkpointEntry)
      .findLast((entry) => entry.data!.sessionId === ctx.sessionManager.getSessionId())?.data;
    this.lastCheckpoint = checkpoint;
    if (!checkpoint) throw new Error("This is an InMemory session, but it has no checkpoint belonging to this session. Create a new InMemory session to continue.");
    const workspace = new Workspace(checkpoint.config, checkpoint.sessionId);
    this.workspace = workspace;
    if (checkpoint.config.cwd !== await realpath(ctx.cwd)) throw new Error("The project location has changed. Resume in the original project or mount the directory in a new InMemory session.");
    const lastState = ctx.sessionManager.getBranch().findLast((entry) => checkpointEntry(entry) ||
      (entry.type === "custom" && entry.customType === "inmemory.position"));
    const interrupted = lastState?.type === "custom" && lastState.customType === "inmemory.position" &&
      (lastState.data as { needsRecovery?: boolean } | undefined)?.needsRecovery;
    if (!selected?.enabled) {
      workspace.failure = `This is a dedicated InMemory session. The current position comes from a legacy ordinary mode or a pending recovery state.\n\n${EXTERNAL_CHOICE}`;
      ctx.ui.notify(workspace.failure, "warning");
      this.status(ctx);
      return;
    }
    await workspace.store.verifyCheckpoint(checkpoint);
    workspace.working = await workspace.store.loadSnapshot(checkpoint.workingId);
    workspace.baseline = await workspace.store.loadSnapshot(checkpoint.baselineId);
    this.task = checkpoint.task ? structuredClone(checkpoint.task) : undefined;
    this.omissions = structuredClone(checkpoint.omissions);
    await workspace.ownership.acquire(workspace.config.root);
    const pending = await workspace.store.pendingTransactions();
    if (pending.length || checkpoint.pendingExternal || interrupted) {
      workspace.externalChange = !!checkpoint.pendingExternal;
      workspace.externalSnapshotId = checkpoint.externalSnapshotId;
      const reasons = [
        ...(checkpoint.pendingExternal || interrupted ? ["The session was saved with unresolved changes"] : []),
        ...(pending.length ? [`The directory has ${pending.length} unfinished file operation records`] : []),
      ];
      workspace.failure = [
        `${reasons.join("; ")}. Disk files were not compared during this resume.`,
        await workspace.knownExternalChanges(),
        EXTERNAL_CHOICE,
      ].filter(Boolean).join("\n\n");
    } else workspace.mode = "ready";
    if (this.task?.status === "running") {
      this.task.status = "incomplete";
      if (workspace.externalChange) this.task.interruption = "external-change";
    }
    if (workspace.mode === "ready") this.drafts.restore(ctx);
    this.status(ctx);
  }

  async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.isIdle()) throw new Error("Wait for the current task to finish, or stop it before using /inmem.");
    const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const action = match?.[1] ?? "status";
    let argument = match?.[2]?.trim() ?? "";
    if ((argument.startsWith('"') && argument.endsWith('"')) || (argument.startsWith("'") && argument.endsWith("'"))) argument = argument.slice(1, -1);
    if (action === "status") {
      const workspace = this.workspace;
      const taskLabels = { running: "running", completed: "completed", incomplete: "incomplete" };
      ctx.ui.notify(workspace ? [
        "Session type: InMemory", `InMemory: ${workspace.mode}`, `Directory: ${workspace.config.root}`,
        `Managed files: ${Object.keys(workspace.working?.manifest.files ?? {}).length}`,
        `Task: ${this.task ? taskLabels[this.task.status] : "none"}`,
        `Working snapshot: ${workspace.working?.id.slice(0, 12) ?? "unavailable"}`,
        `Task baseline: ${workspace.baseline?.id.slice(0, 12) ?? "unavailable"}`,
        `Compacted historical tool calls: ${this.omissions.length}`,
        ...(this.cacheUsage ? [`Latest cache read: ${this.cacheUsage.cacheRead} tokens; write: ${this.cacheUsage.cacheWrite} tokens (reported by host)`] : []),
        ...(workspace.recoveryBackupId ? [`Recovery backup: ${workspace.recoveryBackupId}`] : []),
        ...((workspace.failure ?? this.blocked) ? [`Details: ${workspace.failure ?? this.blocked}`] : []),
      ].join("\n") : `Session type: ${this.memorySession ? "InMemory (recovery pending)" : "ordinary"}${this.blocked ? `\nDetails: ${this.blocked}` : ""}`, "info");
      return;
    }
    if (action === "off") throw new Error("InMemory is a fixed session type. /inmem off cannot turn it into an ordinary session. Use /new to create an ordinary session or /resume to open an existing one.");
    if (action === "on") {
      if (this.memorySession) throw new Error("This is already an InMemory session. Use /inmem recover to recover, or /new before mounting a different directory.");
      if (ctx.sessionManager.getEntries().some((entry) => ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type))) {
        throw new Error("An ordinary session with chat history cannot become an InMemory session. Use /new, then /inmem on [directory] before the first chat message.");
      }
      const config = await mountConfig(ctx.cwd, argument || ".");
      const workspace = new Workspace(config, ctx.sessionManager.getSessionId());
      const excluded = await workspace.mount();
      this.workspace = workspace;
      this.memorySession = true;
      this.task = undefined;
      this.omissions = [];
      this.blocked = undefined;
      await this.save(ctx, "mount");
      this.pi.setLabel(ctx.sessionManager.getLeafId()!, "InMemory: Initial mount");
      ctx.ui.notify(`Mounted ${config.root}\nIncluded: ${Object.keys(workspace.working.manifest.files).join(", ") || "(no files yet)"}\nExcluded: ${excluded.join("; ") || "(none)"}`, "info");
      return;
    }
    const workspace = this.workspace;
    if (!workspace) throw new Error("No directory is mounted. Run /inmem on [directory] first.");
    if (["save-change", "continue"].includes(action)) throw new Error(`Use one of the two commands to handle external changes.\n\n${EXTERNAL_CHOICE}`);
    if (["sync", "recover"].includes(action) && argument) {
      throw new Error(`These commands do not accept arguments.\n\n${EXTERNAL_CHOICE}`);
    }
    if (["sync", "recover"].includes(action)) await this.rollbackSubmission(ctx);
    await workspace.queue.run(async () => {
      if (action === "sync") {
        await this.acceptExternal(ctx);
      } else if (action === "recover") {
        await workspace.ownership.acquire(workspace.config.root);
        if (!workspace.working && this.lastCheckpoint) {
          workspace.working = await workspace.store.loadSnapshot(this.lastCheckpoint.workingId);
        }
        try {
          await workspace.recover(false);
          this.task = undefined;
          // Persist cleared recovery state and finish journals without adding a new tree restore point.
          await this.save(ctx, "position");
        } catch (error) { this.stop(error, ctx); throw error; }
        this.blocked = undefined;
        ctx.ui.notify("External changes discarded; successful assistant edits are preserved. Waiting for a new instruction.\n\nTo undo assistant edits:\n  • /tree: Select a recovery point.", "info");
      } else throw new Error("Usage: /inmem on [directory] | status | check | sync | recover");
    });
    this.drafts.restore(ctx);
  }

  private async rollbackSubmission(ctx: ExtensionCommandContext): Promise<void> {
    const draft = this.drafts.blockedSubmission;
    if (!draft) return;
    if (!draft.beforeEntryId || !this.resolve(ctx, draft.beforeEntryId, false)?.enabled) {
      throw new Error("The original session position for the pending instruction is unavailable. The draft is preserved; check the session history.");
    }
    this.submissionNavigation = { leafId: draft.beforeEntryId, moved: false };
    try {
      const result = await ctx.navigateTree(draft.beforeEntryId, { summarize: false });
      if (result.cancelled || !this.submissionNavigation.moved) {
        throw new Error("Could not return to the position before the pending instruction. The draft and files are preserved.");
      }
    } finally { this.submissionNavigation = undefined; }
  }

  private async acceptExternal(ctx: ExtensionContext): Promise<void> {
    const workspace = this.workspace!;
    const before = workspace.working;
    const oldBaseline = workspace.baseline;
    const oldTask = this.task;
    const oldOmissions = this.omissions;
    const checkpoint = this.lastCheckpoint;
    const disk = await workspace.disk();
    if (workspace.mode === "ready" && disk.id === before.id) {
      ctx.ui.notify("There are no external changes to accept.", "info");
      return;
    }
    const changes = fileChanges(before, disk);
    const changeId = randomUUID();
    const kinds = { added: "Added", modified: "Modified", deleted: "Deleted" };
    try {
      await workspace.ownership.acquire(workspace.config.root);
      await workspace.recover(true);
      // A second external save during this command must be decided separately.
      if (workspace.working.id !== disk.id) throw new Error(`Files changed again while accepting changes.\n\n${EXTERNAL_CHOICE}`);
      await workspace.consistent();
      const additions = this.task ? completedOmissions(ctx.sessionManager.getBranch(), this.task, disk.id) : [];
      this.omissions = [...this.omissions, ...additions];
      this.task = undefined;
      this.pi.sendMessage({ customType: EXTERNAL_CHANGE_TYPE, display: true,
        content: "The user accepted external changes with /inmem sync. These are not assistant tool edits.\n" +
          (changes.map((change) => `${kinds[change.kind]} ${JSON.stringify(change.path)}`).join("\n") || "The current disk files were explicitly accepted.") +
          "\nPaths above are relative to the managed directory. The new task snapshot provides the file contents.",
        details: { version: 1, changeId, root: workspace.config.root, fromId: before?.id,
          toId: disk.id, changes },
      }, { triggerTurn: false });
      const message = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom_message" &&
        entry.customType === EXTERNAL_CHANGE_TYPE && (entry.details as { changeId?: string } | undefined)?.changeId === changeId);
      if (!message) throw new Error("The external-change message has not been saved. Cannot commit the new file state.");
      await this.save(ctx, "external");
      this.pi.setLabel(ctx.sessionManager.getLeafId()!, "InMemory: External changes");
      this.blocked = undefined;
      ctx.ui.notify("External changes were accepted and a change message was saved. You can submit the task again.", "info");
    } catch (error) {
      if (this.lastCheckpoint === checkpoint) {
        workspace.working = before;
        workspace.baseline = oldBaseline;
        this.task = oldTask;
        this.omissions = oldOmissions;
      }
      this.stop(error, ctx);
      throw error;
    }
  }

  private async begin(ctx: ExtensionContext): Promise<void> {
    const workspace = this.workspace!;
    const nextBaseline = workspace.working;
    await workspace.store.saveSnapshot(nextBaseline);
    const additions = this.task ? completedOmissions(ctx.sessionManager.getBranch(), this.task, nextBaseline.id) : [];
    for (const omission of additions) await workspace.store.loadSnapshot(omission.snapshotId);
    this.omissions = [...this.omissions, ...additions];
    workspace.baseline = nextBaseline;
    this.task = { id: randomUUID(), anchorId: null, afterEntryId: this.starting!.beforeEntryId,
      timestamp: Date.now(), status: "running" };
    this.runStarted = true;
    this.lastOutcome = "error";
    await this.save(ctx, "task-start");
  }

  async context(messages: AgentMessage[], ctx: ExtensionContext): Promise<AgentMessage[]> {
    if (!this.enabled) {
      if (this.blocked) throw new Error(this.blocked);
      return messages;
    }
    const workspace = this.workspace!;
    return workspace.queue.run(async () => {
      workspace.assertReady();
      if (this.starting && !this.runStarted) {
        // Checkpoint 1: compare once before starting a new task; continuations keep its frozen baseline.
        await workspace.consistent();
        await this.begin(ctx);
      }
      const task = this.task;
      if (!task || task.status !== "running") throw new Error("There is no active user task. Submit a new instruction first.");
      const branch = ctx.sessionManager.getBranch();
      let start = task.afterEntryId ? branch.findIndex((entry) => entry.id === task.afterEntryId) + 1 : 0;
      if (task.anchorId) start = branch.findIndex((entry) => entry.id === task.anchorId);
      const anchor = branch.slice(Math.max(0, start)).find((entry) => entry.type === "message" && entry.message.role === "user");
      if (!anchor || anchor.type !== "message") throw new Error("Cannot locate the original user instruction for this task.");
      task.anchorId = anchor.id;
      const projectionEntries = ctx.sessionManager.buildSessionProjection().entries;
      const projectedAnchorIndex = projectionEntries.findIndex((entry) => entry.sourceEntry.id === anchor.id);
      const anchorOccurrence = projectionEntries.slice(0, projectedAnchorIndex).flatMap((entry) => entry.messages)
        .filter((message) => message.role === "user" && message.timestamp === anchor.message.timestamp).length;
      const visible = messages.filter((message) => message.role !== "custom" || message.customType !== INSTRUCTION_TYPE ||
        this.drafts.canDeliver((message.details as { draftId?: string } | undefined)?.draftId));
      const result = project(visible, workspace.baseline, task, this.omissions, workspace.config, anchor.message.timestamp, anchorOccurrence);
      const window = ctx.model?.contextWindow;
      if (!window) throw new Error("The model context capacity is unknown. Cannot send the managed-file snapshot.");
      const snapshotEstimate = estimatedTokens(workspaceMessage(workspace.baseline, task, workspace.config));
      const snapshotBudget = Math.min(workspace.config.maxSnapshotTokens, Math.floor(window * 0.25));
      if (snapshotEstimate > snapshotBudget) throw new Error(`The file snapshot is estimated at ${snapshotEstimate} tokens, exceeding the budget of ${snapshotBudget}. Reduce the managed scope or adjust the configuration.`);
      const outputReserve = Math.min(ctx.model!.maxTokens, Math.floor(window * 0.2));
      if (estimatedTokens(result) + outputReserve > window * 0.9) throw new Error("Estimated context capacity is insufficient. The request was stopped without truncating file contents. Finish the task, then compact history or reduce the managed scope.");
      this.drafts.acceptInstructions(branch);
      if (this.starting) { this.drafts.submitted(this.starting.id); this.starting = undefined; }
      return result;
    });
  }

  async turn(ctx: ExtensionContext, outcome: "completed" | "aborted" | "error", anchorId: string): Promise<BoundaryResult | void> {
    if (!this.enabled || !this.runStarted) return;
    this.lastOutcome = outcome;
    const workspace = this.workspace!;
    return workspace.queue.run(async () => {
      if (workspace.mode !== "ready") return;
      await this.save(ctx, "turn", anchorId);
      if (outcome !== "completed") return;
      const report = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      const toolsPending = report?.type === "message" && report.message.role === "assistant" &&
        report.message.content.some((block) => block.type === "toolCall");
      const draft = this.drafts.nextInstruction(ctx.sessionManager.getBranch(), !!toolsPending);
      if (draft) return { entries: [{ type: "custom_message", customType: INSTRUCTION_TYPE, display: true,
        content: [{ type: "text", text: draft.text }, ...(draft.images ?? [])], details: { draftId: draft.id } }], continue: true };
    });
  }

  async settle(ctx: ExtensionContext, aborted: boolean): Promise<void> {
    if (!this.enabled) return;
    const workspace = this.workspace!;
    await workspace.queue.run(async () => {
      if (!this.runStarted) {
        if (workspace.mode !== "ready") await this.save(ctx, "position");
        this.starting = undefined;
        return;
      }
      // Checkpoint 3: final settlement, not every tool round.
      if (workspace.mode === "ready") {
        try { await workspace.consistent(); }
        catch (error) { this.stop(error, ctx); }
      }
      if (workspace.mode !== "ready") {
        this.task!.status = "incomplete";
        await this.recordInterruption(ctx);
        return;
      }
      this.task!.status = !aborted && this.lastOutcome === "completed" ? "completed" : "incomplete";
      this.task!.outcome = aborted ? "aborted" : this.lastOutcome;
      const report = ctx.sessionManager.getBranch().reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
      await this.save(ctx, "settled", report?.id ?? null);
      if (report) this.pi.setLabel(report.id, this.task!.status === "completed" ? "InMemory: Task completed" : "InMemory: Task incomplete");
    });
    this.runStarted = false;
    if (workspace.mode === "ready") this.drafts.restore(ctx);
  }

  async beforeTree(ctx: ExtensionContext, targetId: string, summary: boolean): Promise<void> {
    if (!this.hasMemoryHistory(ctx)) return;
    if (this.submissionNavigation?.leafId === targetId) return;
    const { checkpoint, leafId } = this.treeTarget(ctx, targetId);
    if (summary) throw new Error("InMemory tree navigation does not generate branch summaries.");
    if (checkpoint.config.cwd !== await realpath(ctx.cwd)) throw new Error("The target checkpoint belongs to another project location.");
    const store = new Store(checkpoint.config);
    await store.verifyCheckpoint(checkpoint);
    if (!this.workspace) this.workspace = new Workspace(checkpoint.config, checkpoint.sessionId);
    const workspace = this.workspace;
    await workspace.queue.run(async () => {
      await workspace.ownership.acquire(workspace.config.root);
      // Tree restoration is a managed disk mutation, covered by checkpoint 2.
      const disk = await workspace.consistent();
      const targetSnapshot = await store.loadSnapshot(checkpoint.workingId);
      await workspace.validatePaths(disk, targetSnapshot);
      const transaction = store.transaction(checkpoint.sessionId, "tree", disk.id, checkpoint.workingId);
      transaction.oldLeafId = ctx.sessionManager.getLeafId();
      transaction.targetLeafId = leafId;
      await store.journal(transaction);
      this.prepared = { checkpoint, leafId, transaction };
      workspace.mode = "switching";
      this.status(ctx);
    });
  }

  async beforeSwitch(ctx: ExtensionContext): Promise<void> {
    if (!this.memorySession) return;
    if (!this.workspace || this.workspace.mode !== "ready") {
      if (this.workspace?.working && this.workspace.baseline) {
        await this.workspace.queue.run(() => this.save(ctx, "position"));
      } else this.pi.appendEntry("inmemory.position", { version: 1, needsRecovery: true });
      return;
    }
    const workspace = this.workspace!;
    await workspace.queue.run(async () => {
      // Pi resumes at the final persisted entry. Keep the selected route durable even
      // when files did not change, without presenting a bookkeeping-only restore point.
      await this.save(ctx, "position");
    });
  }

  private hasMemoryHistory(ctx: ExtensionContext): boolean {
    return this.enabled || ctx.sessionManager.getEntries().some(checkpointEntry);
  }

  private treeTarget(ctx: ExtensionContext, targetId: string): TreeTarget {
    const target = ctx.sessionManager.getEntry(targetId);
    if (!target) throw new Error("The session tree target does not exist.");
    const user = target.type === "message" && target.message.role === "user";
    const report = target.type === "message" && target.message.role === "assistant" &&
      !target.message.content.some((block) => block.type === "toolCall");
    // Legacy recovery records remain readable for resume, but are administrative tree entries.
    const standalone = checkpointEntry(target) && ["mount", "sync", "external", "interrupted"].includes(target.data!.kind);
    if (!user && !report && !standalone && target.type !== "compaction") throw new Error("This node is not a recoverable task start or stable checkpoint.");
    // Older versions saved unchanged session departures as unlabeled sync entries.
    // Keep their raw records for resume, but collapse duplicate leaves in the tree.
    if (checkpointEntry(target) && target.data!.kind === "sync" && !ctx.sessionManager.getLabel(target.id)) {
      const previous = this.resolve(ctx, target.parentId, false);
      if (previous && sameRecoveryState(previous, target.data!)) throw new Error("This record only saves a session position and has no new recovery state.");
    }
    const leafId = user ? target.parentId : target.id;
    const inherited = this.resolve(ctx, leafId, false);
    if (!inherited?.enabled) throw new Error("Select an InMemory position with a file snapshot. An InMemory session cannot return to a legacy ordinary-mode position.");
    const checkpoint = this.resolve(ctx, leafId)!;
    if (checkpoint.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("The checkpoint does not belong to the current session.");
    if (checkpoint.task?.status === "running" && !(user && checkpoint.kind === "task-start")) throw new Error("This task does not have a stable checkpoint yet.");
    if (report && (checkpoint.kind !== "settled" || checkpoint.anchorId !== target.id)) throw new Error("This report is not linked to a final checkpoint yet.");
    if (this.workspace && this.workspace.config.root !== checkpoint.config.root) throw new Error("Recovery across mount directories is not supported. Create a new InMemory session to mount another directory.");
    return { checkpoint, leafId };
  }

  async openTree(event: SessionTreeOpenEvent, ctx: ExtensionContext): Promise<void> {
    if (!this.hasMemoryHistory(ctx)) return;
    event.skipSummaryPrompt = true;
    event.initialFilterMode = "all";
    const cwd = await realpath(ctx.cwd);
    const allowed = new Set<string>();
    const verified = new Map<string, Promise<void>>();
    for (const entry of ctx.sessionManager.getEntries()) {
      try {
        const { checkpoint } = this.treeTarget(ctx, entry.id);
        if (checkpoint.config.cwd !== cwd) continue;
        let verification = verified.get(checkpoint.id);
        if (!verification) {
          verification = new Store(checkpoint.config).verifyCheckpoint(checkpoint);
          verified.set(checkpoint.id, verification);
        }
        await verification;
        allowed.add(entry.id);
      } catch { /* Unsupported or damaged targets do not appear in the selectable view. */ }
    }
    event.tree = selectableTree(event.tree, allowed);
    event.currentLeafId = visibleLeaf(ctx.sessionManager.getEntries(), event.currentLeafId, allowed);
  }

  async afterTree(ctx: ExtensionContext, actualLeafId: string | null): Promise<void> {
    if (this.submissionNavigation) {
      if (actualLeafId !== this.submissionNavigation.leafId) throw new Error("The session position does not match the pending instruction.");
      this.submissionNavigation.moved = true;
      return;
    }
    if (!this.prepared) return;
    const prepared = this.prepared;
    this.prepared = undefined;
    // Pi may append a label after moving; it is harmless metadata on the actual target path.
    let leaf = actualLeafId ? ctx.sessionManager.getEntry(actualLeafId) : undefined;
    while (leaf?.type === "label") leaf = leaf.parentId ? ctx.sessionManager.getEntry(leaf.parentId) : undefined;
    if (actualLeafId !== prepared.leafId && (leaf?.id ?? null) !== prepared.leafId) {
      throw new Error("The actual Pi session position differs from the prepared file checkpoint. Managed operations were stopped.");
    }
    const workspace = this.workspace!;
    const checkpoint = prepared.checkpoint;
    await workspace.queue.run(async () => {
      const working = await workspace.store.loadSnapshot(checkpoint.workingId);
      const baseline = await workspace.store.loadSnapshot(checkpoint.baselineId);
      // The host already moved. Recovery must now target this branch, even if disk restore fails.
      workspace.working = working;
      workspace.baseline = baseline;
      this.task = checkpoint.task ? structuredClone(checkpoint.task) : undefined;
      if (this.task?.status === "running") this.task.status = "incomplete";
      this.omissions = structuredClone(checkpoint.omissions);
      this.lastCheckpoint = checkpoint;
      await workspace.restore(working, prepared.transaction);
      // Selecting an unfinished branch restores legitimate files but keeps the decision pending.
      workspace.externalChange = !!checkpoint.pendingExternal;
      workspace.externalSnapshotId = checkpoint.pendingExternal ? checkpoint.externalSnapshotId : undefined;
      workspace.mode = checkpoint.pendingExternal ? "needs-recovery" : "ready";
      workspace.failure = checkpoint.pendingExternal
        ? [await workspace.knownExternalChanges(), EXTERNAL_CHOICE].filter(Boolean).join("\n\n") : undefined;
      this.drafts.load(ctx.sessionManager.getBranch());
      this.drafts.restore(ctx);
      this.blocked = undefined;
      prepared.transaction.phase = "done";
      await workspace.store.journal(prepared.transaction);
      this.status(ctx);
    });
  }

  async compact(ctx: ExtensionContext, compactionId: string): Promise<void> {
    if (!this.enabled) return;
    const workspace = this.workspace!;
    await workspace.queue.run(async () => {
      workspace.assertReady();
      workspace.baseline = workspace.working;
      await this.save(ctx, "compaction", compactionId);
    });
  }

  async close(): Promise<void> {
    if (this.workspace) await this.workspace.queue.run(() => this.workspace!.ownership.release());
  }

  observeRequest(payload: unknown, ctx: ExtensionContext): unknown {
    if (!this.enabled || !this.runStarted || !this.task || !payload || typeof payload !== "object") return;
    const value = payload as Record<string, unknown>;
    if (ctx.model?.api !== "anthropic-messages" || !Array.isArray(value.messages)) return;
    const adapted = preserveTaskCache(payload, this.task.id, this.cacheAnchor);
    this.cacheAnchor = adapted.anchor;
    const messages = value.messages as Array<{ role?: string; content?: unknown }>;
    this.pi.appendEntry("inmemory.request", {
      version: 1, taskId: this.task.id, provider: ctx.model.provider, model: ctx.model.id,
      baselineId: this.workspace!.baseline.id, roles: messages.map((message) => message.role),
      contentBlocks: messages.map((message) => Array.isArray(message.content) ? message.content.length : 1),
    });
    return adapted.payload;
  }

  observeUsage(message: AgentMessage): void {
    if (!this.enabled || !this.runStarted || message.role !== "assistant") return;
    this.cacheUsage = { input: message.usage.input, cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite, provider: message.provider, model: message.model };
    this.pi.appendEntry("inmemory.usage", { version: 1, taskId: this.task?.id, ...this.cacheUsage });
  }
}
