import { relative } from "node:path";
import * as vscode from "vscode";
import type { Logger } from "./logging.ts";
import { Sessions, type Session } from "./sessions.ts";
import type { DiffDocuments } from "./views.ts";

export type ReviewDecision = "continue" | "recover";
export type ConfirmDecision = (title: string, detail: string, action: string) => Promise<boolean>;
const confirmInWindow: ConfirmDecision = async (title, detail, action) =>
  await vscode.window.showWarningMessage(title, { modal: true, detail }, action) === action;

function dirtyDocuments(session: Session): vscode.TextDocument[] {
  const paths = new Set([...session.state.files, ...session.state.changes.map((change) => change.path)]);
  return vscode.workspace.textDocuments.filter((document) => document.isDirty && document.uri.scheme === "file" &&
    paths.has(relative(session.state.root!, document.uri.fsPath)));
}

/** The same workflow serves the IDE buttons and functional host tests; only the confirmation UI is injected. */
export async function applyReviewDecision(sessions: Sessions, decision: ReviewDecision, confirm = confirmInWindow): Promise<boolean> {
  let session = await sessions.require();
  if (!session?.state.root || !session.state.workingId) throw new Error("Mount a directory first.");
  if (session.state.busy) throw new Error("Wait for the current task to pause or finish.");
  const instance = session.connection.instanceId, sessionId = session.state.sessionId;
  const dirty = dirtyDocuments(session);
  if (decision === "continue") {
    for (const document of dirty) if (!await document.save()) throw new Error("Files could not be saved. Continue was cancelled.");
  }
  // Refresh the disk version after edits. This only records the decision pending; it never accepts content.
  await sessions.run({ type: "check" }, session);
  session = sessions.entries.find((entry) => entry.connection.instanceId === instance && entry.state.sessionId === sessionId);
  if (!session?.state.root || !session.state.workingId) throw new Error("The original Pi session changed or disconnected. The operation was cancelled.");
  const action = decision === "continue" ? "Continue: Accept Resolved Files" : "Recover: Discard External Changes";
  const detail = `Applies to the entire mounted directory: ${session.state.root}\n${session.state.changes.length} changed files.\n` +
    (decision === "continue" ? "Managed edits have been saved. The current disk files will become the accepted version."
      : `Restore the last accepted Pi version, preserving successful assistant edits.${dirty.length ? ` Unsaved edits in ${dirty.length} managed files will also be discarded.` : ""}`) +
    "\nThe pending instruction will be restored to the input. Send it again to start the task; the model will not run automatically.";
  if (!await confirm(`${action}?`, detail, action)) return false;
  if (decision === "recover") {
    for (const document of dirtyDocuments(session)) {
      await vscode.commands.executeCommand("workbench.action.files.revert", document.uri);
      if (document.isDirty) throw new Error("Some edits could not be reverted. Recover was cancelled; check the unsaved files.");
    }
  }
  await sessions.run({ type: decision === "continue" ? "sync" : "recover", workingId: session.state.workingId,
    externalSnapshotId: session.state.externalSnapshotId }, session);
  return true;
}

export class ConflictReview implements vscode.Disposable {
  private readonly sessions: Sessions;
  private readonly diffs: DiffDocuments;
  private readonly logger: Logger;
  private readonly subscription: vscode.Disposable;
  private openedKey?: string;
  private opening?: Promise<void>;
  private deciding = false;
  private disposed = false;

  constructor(sessions: Sessions, diffs: DiffDocuments, logger: Logger) {
    this.sessions = sessions;
    this.diffs = diffs;
    this.logger = logger;
    this.subscription = sessions.onDidChange(() => this.update());
  }

  update(): void {
    if (this.disposed) return;
    const session = this.sessions.selected;
    if (!session || session.state.mode !== "needs-recovery") {
      if (this.openedKey) void this.diffs.closeReviews().catch((error) => this.logger.warn("Failed to close diff editors", String(error)));
      this.openedKey = undefined;
      return;
    }
    if (this.deciding || this.opening || session.state.busy || !session.state.changes.length ||
      !vscode.workspace.getConfiguration("piInMemory").get<boolean>("autoOpenChanges", true)) return;
    const key = `${session.connection.instanceId}:${session.state.sessionId}:${session.state.workingId}`;
    if (this.openedKey === key) return;
    this.openedKey = key;
    void this.openAll(session).catch((error) => this.logger.warn("Failed to open pending diffs automatically. Use Pi: Open All Pending Diffs to retry", String(error)));
  }

  async openAll(session?: Session): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.open(session).finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async open(session?: Session): Promise<void> {
    session ??= await this.sessions.require();
    if (!session?.state.root || !session.state.workingId || !session.state.externalSnapshotId || !session.state.changes.length) {
      throw new Error("No detected file differences. Run Pi: Check External Changes first.");
    }
    const result = await this.sessions.run({ type: "diffs", workingId: session.state.workingId,
      externalSnapshotId: session.state.externalSnapshotId }, session);
    // A switch/Continue while fetching must not reopen an obsolete session's review.
    const current = this.sessions.selected;
    if (this.disposed || current?.connection.instanceId !== session.connection.instanceId || current.state.sessionId !== session.state.sessionId ||
      current.state.mode !== "needs-recovery" || current.state.workingId !== session.state.workingId || current.state.externalSnapshotId !== session.state.externalSnapshotId) return;
    await this.diffs.showAll(result.diffs ?? [], session.state.root, `${session.connection.instanceId}:${session.state.sessionId}`);
    this.logger.info("Opened the multi-file review for pending changes", { files: result.diffs?.length ?? 0 });
  }

  async decide(decision: ReviewDecision): Promise<void> {
    if (this.deciding) throw new Error("A change decision is in progress. Wait for it to finish.");
    this.deciding = true;
    try {
      if (await applyReviewDecision(this.sessions, decision)) {
        await this.diffs.closeReviews();
        void vscode.window.showInformationMessage(decision === "continue" ? "Resolved files accepted. The pending instruction is back in the input; send it to continue the task." : "External changes discarded. Successful assistant edits are preserved; send the instruction to continue.");
      }
    } finally { this.deciding = false; this.update(); }
  }

  dispose(): void { this.disposed = true; this.subscription.dispose(); }
}
