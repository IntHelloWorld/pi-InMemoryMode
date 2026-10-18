import * as vscode from "vscode";
import type { IdeAction, IdeConnection, IdeResult, IdeState } from "../../src/ide-protocol.ts";
import { discover, perform, readState } from "./client.ts";
import { inside } from "./model.ts";
import type { Logger } from "./logging.ts";

export interface Session { connection: IdeConnection; state: IdeState }

export class Sessions implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  private selectedId?: string;
  private stopped = false;
  private readonly logger: Logger;
  private readonly failures = new Map<string, string>();
  entries: Session[] = [];

  constructor(logger: Logger) { this.logger = logger; }

  get selected(): Session | undefined { return this.entries.find((entry) => entry.connection.instanceId === this.selectedId); }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, 1500);
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.scan().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async scan(): Promise<void> {
    if (this.stopped || !vscode.workspace.isTrusted || vscode.env.remoteName) return;
    const roots = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath) ?? [];
    let connections: IdeConnection[];
    try { connections = await discover(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.failures.get("registry") !== message) this.logger.warn("Failed to read the Pi connection directory", message);
      this.failures.set("registry", message);
      connections = [];
    }
    const entries = await Promise.all(connections.map(async (connection): Promise<Session | undefined> => {
      try {
        if (!roots.some((root) => inside(root, connection.cwd) || inside(connection.cwd, root))) return;
        const state = await readState(connection);
        if (this.failures.delete(connection.instanceId)) this.logger.info("Pi connection restored", connection.instanceId);
        return { connection, state };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.failures.get(connection.instanceId) !== message) this.logger.warn("Failed to read Pi state", connection.instanceId, message);
        this.failures.set(connection.instanceId, message);
        return;
      }
    }));
    if (this.stopped) return;
    const before = JSON.stringify({ entries: this.entries, selected: this.selectedId });
    const next = entries.filter((entry): entry is Session => !!entry).sort((a, b) => a.connection.instanceId.localeCompare(b.connection.instanceId));
    for (const entry of next) {
      const old = this.entries.find((previous) => previous.connection.instanceId === entry.connection.instanceId);
      if (!old) this.logger.info("Pi session discovered", { instance: entry.connection.instanceId, pid: entry.connection.pid, cwd: entry.state.cwd });
      if (!old || old.state.mode !== entry.state.mode || old.state.busy !== entry.state.busy || old.state.root !== entry.state.root ||
        old.state.workingId !== entry.state.workingId || old.state.externalSnapshotId !== entry.state.externalSnapshotId) {
        this.logger.info("Pi state updated", { session: entry.state.sessionId, mode: entry.state.mode, busy: entry.state.busy,
          root: entry.state.root, files: entry.state.files.length, pending: entry.state.changes.length });
      }
    }
    for (const old of this.entries) if (!next.some((entry) => entry.connection.instanceId === old.connection.instanceId)) this.logger.info("Pi session disconnected", old.connection.instanceId);
    this.entries = next;
    if (!this.selected && this.entries.length === 1) this.selectedId = this.entries[0]!.connection.instanceId;
    if (before !== JSON.stringify({ entries: this.entries, selected: this.selectedId })) this.emitter.fire();
  }

  select(instanceId: string): void { this.selectedId = instanceId; this.logger.info("Pi session selected", instanceId); this.emitter.fire(); }

  async choose(): Promise<Session | undefined> {
    await this.refresh();
    const items = this.entries.map((entry) => ({ label: entry.state.sessionName ?? entry.state.sessionId.slice(0, 12),
      description: entry.state.root ?? "Ordinary session", detail: entry.state.cwd, entry }));
    if (!items.length) { void vscode.window.showInformationMessage("No Pi session was found for this project. Start Pi and make sure the current InMemory plugin is loaded."); return; }
    const choice = await vscode.window.showQuickPick(items, { title: "Select a Pi session", matchOnDescription: true, matchOnDetail: true });
    if (!choice) return;
    this.select(choice.entry.connection.instanceId);
    return choice.entry;
  }

  async require(): Promise<Session | undefined> {
    await this.refresh();
    return this.selected ?? this.choose();
  }

  async run(action: IdeAction, session = this.selected): Promise<IdeResult> {
    if (!session) throw new Error("Select a Pi session first.");
    this.logger.info("Requesting Pi operation", { action: action.type, session: session.state.sessionId });
    try {
      const result = await perform(session.connection, session.state, action);
      this.logger.info("Pi operation completed", { action: action.type, disposition: result.disposition, message: result.message });
      return result;
    }
    catch (error) { this.logger.error("Pi operation failed", action.type, error instanceof Error ? error.message : String(error)); throw error; }
    finally { await this.refresh(); }
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.emitter.dispose();
  }
}
