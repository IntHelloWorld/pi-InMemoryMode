import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import * as vscode from "vscode";
import type { IdeState } from "../../src/ide-protocol.ts";
import { registryDirectory } from "./client.ts";
import { formatSelection, inside } from "./model.ts";
import { Sessions, type Session } from "./sessions.ts";
import { DiffDocuments, FilesView, type FileNode } from "./views.ts";
import { prepareLaunch } from "./launcher.ts";
import { ConflictReview } from "./review.ts";

export interface InMemoryApi { refresh(): Promise<void>; getSelectedState(): IdeState | undefined }

export function activate(context: vscode.ExtensionContext): InMemoryApi {
  const logs = vscode.window.createOutputChannel("Pi InMemory", { log: true });
  const sessions = new Sessions(logs);
  const files = new FilesView(sessions);
  const diffs = new DiffDocuments();
  const review = new ConflictReview(sessions, diffs, logs);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 60);
  const recoverStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 59);
  recoverStatus.text = "$(discard) Pi: Recover";
  recoverStatus.tooltip = "Discard external changes and unsaved managed edits (confirmation required)";
  recoverStatus.command = "piInMemory.recover";
  const terminals = new Map<string, vscode.Terminal>();
  status.command = "piInMemory.focus";
  context.subscriptions.push(logs, sessions, files, review, status, recoverStatus,
    vscode.window.registerTreeDataProvider("piInMemory.files", files),
    vscode.window.registerFileDecorationProvider(files),
    vscode.workspace.registerTextDocumentContentProvider("pi-inmemory-diff", diffs),
    vscode.workspace.onDidCloseTextDocument((document) => diffs.release(document.uri)));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("piInMemory.autoOpenChanges")) review.update();
  }));
  logs.info(`Pi InMemory ${context.extension.packageJSON.version} started`, {
    workspaces: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [], trusted: vscode.workspace.isTrusted,
    registry: registryDirectory() });

  function render(): void {
    const state = sessions.selected?.state;
    const pending = state?.mode === "needs-recovery";
    void vscode.commands.executeCommand("setContext", "piInMemory.connected", !!state);
    void vscode.commands.executeCommand("setContext", "piInMemory.mounted", !!state?.root);
    void vscode.commands.executeCommand("setContext", "piInMemory.pending", pending);
    void vscode.commands.executeCommand("setContext", "piInMemory.hasChanges", pending && !!state?.changes.length);
    status.text = state ? `$(terminal) Pi · ${pending ? "Changes pending" : state.busy ? "Running" : "Idle"}${state.root ? ` · ${state.files.length} files` : " · No mount"}` : "$(terminal) Pi · Disconnected";
    status.tooltip = state ? `${state.sessionName ?? state.sessionId}\n${state.root ?? state.cwd}\nClick to focus the terminal` : "Start Pi or select a running session";
    status.backgroundColor = pending ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    status.show();
    if (pending) recoverStatus.show(); else recoverStatus.hide();
  }
  context.subscriptions.push(sessions.onDidChange(render));

  function command(name: string, handler: (...args: any[]) => unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand(`piInMemory.${name}`, async (...args: any[]) => {
      try {
        if (!vscode.workspace.isTrusted) throw new Error("Trust the current workspace first.");
        if (vscode.env.remoteName) throw new Error("This version supports local VS Code workspaces and local Pi terminals.");
        return await handler(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logs.error(`Operation failed: ${name}`, message);
        void vscode.window.showErrorMessage(`Pi: ${message}`, "Show Logs").then((choice) => { if (choice) logs.show(); });
      }
    }));
  }

  async function folder(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
    if (uri instanceof vscode.Uri && uri.scheme === "file") return uri;
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Select Directory" });
    return selected?.[0];
  }

  async function launch(mount?: vscode.Uri): Promise<void> {
    const workspace = mount ? vscode.workspace.getWorkspaceFolder(mount) :
      vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : await vscode.window.showWorkspaceFolderPick();
    if (!workspace || workspace.uri.scheme !== "file") throw new Error("Open a local project folder in VS Code first.");
    const config = vscode.workspace.getConfiguration("piInMemory");
    const executable = config.get<string>("executable", "pi");
    const nodeExecutable = config.get<string>("nodeExecutable", "");
    const plugin = config.get<string>("pluginPath", "");
    const extra = config.get<string[]>("arguments", []);
    if (plugin && !isAbsolute(plugin)) throw new Error("The plugin path must be absolute.");
    if (!executable.trim() || !extra.every((arg) => typeof arg === "string")) throw new Error("Invalid Pi launch configuration.");
    const runtime = await prepareLaunch(executable, nodeExecutable);
    logs.info("Preparing to start Pi", { executable: runtime.executable, node: runtime.node, plugin: plugin || "Installed Pi plugin",
      cwd: workspace.uri.fsPath, mount: mount?.fsPath, extraArgumentCount: extra.length });
    const id = randomUUID();
    // Launch Pi as the terminal process, passing arguments without shell interpolation.
    const terminal = vscode.window.createTerminal({ name: "Pi InMemory", cwd: workspace.uri.fsPath,
      shellPath: runtime.executable, shellArgs: [...(plugin ? ["-e", plugin] : []), ...extra],
      env: { PATH: runtime.path, PI_INMEMORY_TERMINAL_ID: id, PI_INMEMORY_IDE_DIR: registryDirectory(), PI_INMEMORY_MOUNT: mount?.fsPath ?? null } });
    terminals.set(id, terminal);
    terminal.show();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: mount ? "Starting Pi and mounting directory" : "Connecting to Pi", cancellable: false }, async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        await sessions.refresh();
        const entry = sessions.entries.find((item) => item.connection.terminalId === id);
        if (entry && (!mount || entry.state.root)) { sessions.select(entry.connection.instanceId); logs.info("Pi started", { terminal: id, root: entry.state.root }); return; }
        if (entry?.state.reason) throw new Error(entry.state.reason);
        if (terminal.exitStatus) throw new Error(`The Pi terminal exited (code ${terminal.exitStatus.code ?? "unknown"}). Check the Pi and Node.js paths in the logs.`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("Could not connect to Pi. Check the terminal for InMemory plugin loading errors and verify the Pi executable and plugin path settings.");
    });
  }

  async function focus(session?: Session): Promise<void> {
    session ??= await sessions.require();
    if (!session) return;
    let terminal = terminals.get(session.connection.terminalId ?? session.connection.instanceId);
    terminal ??= vscode.window.terminals.find((candidate) => {
      const options = candidate.creationOptions;
      return "env" in options && options.env?.PI_INMEMORY_TERMINAL_ID === session!.connection.terminalId && !!session!.connection.terminalId;
    });
    if (!terminal) {
      const choices = vscode.window.terminals.map((item) => ({ label: item.name, terminal: item }));
      if (!choices.length) return;
      terminal = (await vscode.window.showQuickPick(choices, { title: "Select the terminal for this Pi session (used only to focus the terminal)" }))?.terminal;
      if (terminal) terminals.set(session.connection.instanceId, terminal);
    }
    terminal?.show();
  }

  async function selection(destination: "draft" | "send"): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) throw new Error("Select the text to share with Pi first.");
    const session = await sessions.require();
    if (!session) return;
    const document = editor.document;
    const path = document.uri.scheme === "file" && inside(session.state.cwd, document.uri.fsPath)
      ? relative(session.state.cwd, document.uri.fsPath) : document.uri.scheme === "file" ? document.uri.fsPath : document.uri.toString();
    const range = editor.selection;
    const endLine = range.end.character === 0 && range.end.line > range.start.line ? range.end.line : range.end.line + 1;
    const text = formatSelection(path, range.start.line + 1, endLine, document.getText(range), document.isDirty);
    const result = await sessions.run({ type: "selection", destination, text }, session);
    void vscode.window.showInformationMessage(result.message);
    await focus(session);
  }

  command("start", () => launch());
  command("mount", async (uri?: vscode.Uri) => { const directory = await folder(uri); if (directory) await launch(directory); });
  command("selectSession", () => sessions.choose());
  command("focus", () => focus());
  command("refresh", () => sessions.refresh());
  command("showLogs", () => logs.show());
  command("check", async () => {
    const session = await sessions.require();
    if (session) { const result = await sessions.run({ type: "check" }, session); void vscode.window.showInformationMessage(result.message); }
  });
  command("addSelection", () => selection("draft"));
  command("sendSelection", () => selection("send"));
  command("continue", () => review.decide("continue"));
  command("sync", () => review.decide("continue"));
  command("recover", () => review.decide("recover"));
  command("diffAll", () => review.openAll());
  command("diff", async (node?: FileNode | vscode.Uri) => {
    const session = await sessions.require();
    if (!session?.state.root || !session.state.workingId || !session.state.externalSnapshotId) throw new Error("No detected file differences. Run Pi: Check External Changes first.");
    const path = node instanceof vscode.Uri ? relative(session.state.root, node.fsPath) : node?.path;
    if (!path || !session.state.changes.some((change) => change.path === path)) throw new Error("Select a file from the pending changes list.");
    const result = await sessions.run({ type: "diff", path, workingId: session.state.workingId, externalSnapshotId: session.state.externalSnapshotId }, session);
    if (result.diff) await diffs.show(result.diff, session.state.root);
  });
  context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
    for (const [id, item] of terminals) if (item === terminal) { logs.info("Pi terminal closed", { terminal: id, exitCode: terminal.exitStatus?.code }); terminals.delete(id); }
    void sessions.refresh();
  }));
  render();
  sessions.start();
  return { refresh: () => sessions.refresh(), getSelectedState: () => sessions.selected?.state };
}
