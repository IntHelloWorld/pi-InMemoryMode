import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type { IdeChange, IdeDiff } from "../../src/ide-protocol.ts";
import { decoration } from "./model.ts";
import type { Sessions } from "./sessions.ts";

export interface FileNode { kind: "file"; path: string; change?: IdeChange }
export type Node = FileNode | { kind: "managed" } | { kind: "changes" } | { kind: "info"; text: string }
  | { kind: "action"; action: "continue" | "recover" };

export class FilesView implements vscode.TreeDataProvider<Node>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly treeEmitter = new vscode.EventEmitter<void>();
  private readonly decorationsEmitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.treeEmitter.event;
  readonly onDidChangeFileDecorations = this.decorationsEmitter.event;
  private readonly subscription: vscode.Disposable;
  private readonly sessions: Sessions;

  constructor(sessions: Sessions) {
    this.sessions = sessions;
    this.subscription = sessions.onDidChange(() => { this.treeEmitter.fire(); this.decorationsEmitter.fire(undefined); });
  }

  getChildren(node?: Node): Node[] {
    const state = this.sessions.selected?.state;
    if (!state) return [];
    if (!node) {
      if (!state.root) return [{ kind: "info", text: state.reason ?? "This session has no mounted directory. Right-click a folder to mount it in a new session." }];
      return [
        ...(state.mode === "needs-recovery" ? [
          { kind: "action" as const, action: "continue" as const },
          { kind: "action" as const, action: "recover" as const },
        ] : []),
        { kind: "info", text: state.root },
        { kind: "info", text: state.checkedAt ? `Last checked: ${new Date(state.checkedAt).toLocaleString("en-US")}` : "Disk not checked yet (check on demand after resuming)" },
        ...(state.reason ? [{ kind: "info" as const, text: state.reason }] : []),
        { kind: "changes" }, { kind: "managed" },
      ];
    }
    if (node.kind === "changes") return state.changes.map((change) => ({ kind: "file", path: change.path, change }));
    if (node.kind === "managed") return state.files.map((path) => ({ kind: "file", path }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const state = this.sessions.selected?.state;
    if (node.kind === "action") {
      const recover = node.action === "recover";
      const item = new vscode.TreeItem(recover ? "Recover · Discard External Changes" : "Continue · Accept Resolved Files");
      item.id = `action-${node.action}`;
      item.iconPath = new vscode.ThemeIcon(recover ? "discard" : "debug-continue");
      item.tooltip = recover ? "After confirmation, discard external disk changes and unsaved managed edits in this review, preserving successful Pi edits."
        : "Save managed edits, check and accept the current files, then restore the pending instruction for you to send again.";
      item.command = { command: `piInMemory.${node.action}`, title: recover ? "Recover" : "Continue" };
      return item;
    }
    if (node.kind === "managed" || node.kind === "changes") {
      const pending = node.kind === "changes";
      const item = new vscode.TreeItem(pending ? `Pending Changes (${state?.changes.length ?? 0})` : `Managed Files (${state?.files.length ?? 0})`,
        pending ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = node.kind;
      item.iconPath = new vscode.ThemeIcon(pending ? "warning" : "files");
      return item;
    }
    if (node.kind === "info") {
      const item = new vscode.TreeItem(node.text.split("\n")[0]!);
      item.tooltip = node.text;
      return item;
    }
    const item = new vscode.TreeItem(node.path);
    item.resourceUri = vscode.Uri.file(resolve(state!.root!, node.path));
    if (node.change) {
      const labels = { added: "Added", modified: "Modified", deleted: "Deleted" };
      item.description = labels[node.change.kind] + (node.change.permissionsChanged ? " · Permissions changed" : "");
      item.iconPath = new vscode.ThemeIcon(node.change.kind === "deleted" ? "diff-removed" : "diff-modified", new vscode.ThemeColor("list.warningForeground"));
      item.contextValue = "piChange";
      item.command = { command: "piInMemory.diff", title: "Show Diff", arguments: [node] };
    } else item.command = { command: "vscode.open", title: "Open File", arguments: [item.resourceUri] };
    return item;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") return;
    const value = decoration(this.sessions.selected?.state, uri.fsPath);
    if (!value) return;
    const result = new vscode.FileDecoration(value.badge, value.tooltip,
      new vscode.ThemeColor(value.pending ? "list.warningForeground" : "piInMemory.managed"));
    // Explicitly decorate ancestors inside the mount; never mark the entire project.
    result.propagate = false;
    return result;
  }

  dispose(): void { this.subscription.dispose(); this.treeEmitter.dispose(); this.decorationsEmitter.dispose(); }
}

export class DiffDocuments implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>();
  private readonly reviews = new Map<string, { signature: string; resources: [vscode.Uri, vscode.Uri, vscode.Uri][] }>();

  provideTextDocumentContent(uri: vscode.Uri): string { return this.documents.get(uri.toString()) ?? ""; }

  private async resources(diff: IdeDiff, root: string): Promise<[vscode.Uri, vscode.Uri, vscode.Uri]> {
    // Immutable, content-addressed resources let single-file diffs reuse their native editor too.
    const uri = (side: string, text: string, exists: boolean) => vscode.Uri.from({ scheme: "pi-inmemory-diff",
      path: `/${basename(diff.path)}`, query: createHash("sha256").update(JSON.stringify([root, diff.path, side, exists, text])).digest("hex") });
    const before = uri("before", diff.before, diff.beforeExists), after = uri("after", diff.after, diff.afterExists);
    this.documents.set(before.toString(), diff.before);
    const file = vscode.Uri.file(resolve(root, diff.path));
    let modified = after;
    if (diff.afterExists) {
      try {
        const info = await vscode.workspace.fs.stat(file);
        if ((info.type & vscode.FileType.File) && !(info.type & vscode.FileType.SymbolicLink)) modified = file;
      } catch { /* Deleted since inspection: retain the detected version until the next check. */ }
    }
    if (modified === after) this.documents.set(after.toString(), diff.after);
    return [file, before, modified];
  }

  async show(diff: IdeDiff, root: string): Promise<void> {
    const [, before, after] = await this.resources(diff, root);
    const label = `${diff.path}: Pi version${diff.beforeExists ? "" : " (absent)"} ↔ ${after.scheme === "file" ? "Current file (editable)" : "Last inspected version (read-only)"}`;
    await vscode.commands.executeCommand("vscode.diff", before, after, label, { preview: false });
    if (diff.beforeMode !== undefined && diff.afterMode !== undefined && diff.beforeMode !== diff.afterMode) {
      void vscode.window.showInformationMessage(`File permissions: ${diff.beforeMode.toString(8)} → ${diff.afterMode.toString(8)}; content differences are shown in the editor.`);
    }
  }

  async showAll(diffs: IdeDiff[], root: string, session: string): Promise<void> {
    const resources = await Promise.all(diffs.map((diff) => this.resources(diff, root)));
    // vscode.changes creates a fresh native input on every call, even for identical resources.
    // The session suffix also lets us find the tab after VS Code rebuilds its Tab objects.
    const title = `Pi: Pending Changes · ${basename(root)} · ${createHash("sha256").update(session).digest("hex").slice(0, 6)}`;
    const signature = JSON.stringify(resources.map((entry) => entry.map((uri) => uri.toString())));
    const existing = this.findReview(title);
    if (existing && this.reviews.get(title)?.signature === signature) {
      await this.reveal(existing);
      return;
    }
    if (existing) {
      // A new file set needs a new native input. Keep dirty files open in ordinary editors so
      // replacing the container cannot dispose their buffers, undo history or unsaved edits.
      const oldFiles = new Set(this.reviews.get(title)?.resources.map((entry) => entry[2].toString()));
      for (const document of vscode.workspace.textDocuments) {
        if (document.isDirty && oldFiles.has(document.uri.toString())) {
          await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true, viewColumn: existing.group.viewColumn });
        }
      }
      if (!await vscode.window.tabGroups.close(existing, true)) throw new Error("Cannot refresh the existing diff editor. Close it and try again.");
      // Closing the old input can release its snapshot documents.
      await Promise.all(diffs.map((diff) => this.resources(diff, root)));
    }
    this.reviews.set(title, { signature, resources });
    this.pruneDocuments();
    await vscode.commands.executeCommand("vscode.changes", title, resources);
    await this.reveal(await this.waitForTab(() => this.findReview(title)));
    await vscode.commands.executeCommand("workbench.action.keepEditor");
  }

  private findReview(title: string): vscode.Tab | undefined {
    // VS Code appends a localized file count to the label.
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) => tab.label.startsWith(title));
  }

  private async reveal(tab: vscode.Tab): Promise<void> {
    // Use built-in navigation commands: no proposed multi-diff Tab API or private open command.
    for (let remaining = vscode.window.tabGroups.all.length; remaining > 0 && !tab.group.isActive; remaining--) {
      await vscode.commands.executeCommand("workbench.action.focusNextGroup");
    }
    const index = tab.group.tabs.indexOf(tab);
    if (!tab.group.isActive || index < 0) throw new Error("The diff editor was moved or closed. Try again.");
    await vscode.commands.executeCommand("workbench.action.openEditorAtIndex", index);
    await this.waitForTab(() => tab.group.isActive && tab.isActive ? tab : undefined);
  }

  private async waitForTab(find: () => vscode.Tab | undefined): Promise<vscode.Tab> {
    const current = find();
    if (current) return current;
    return new Promise((resolve, reject) => {
      const changed = () => {
        const tab = find();
        if (tab) { clearTimeout(timeout); subscription.dispose(); resolve(tab); }
      };
      const subscription = vscode.Disposable.from(vscode.window.tabGroups.onDidChangeTabs(changed), vscode.window.tabGroups.onDidChangeTabGroups(changed));
      const timeout = setTimeout(() => { subscription.dispose(); reject(new Error("Timed out waiting for the diff editor. Try again.")); }, 5000);
    });
  }

  async closeReviews(): Promise<void> {
    const all = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const closable = all.filter((tab) => !tab.isDirty && (
      tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === "pi-inmemory-diff" ||
      [...this.reviews.keys()].some((title) => tab.label.startsWith(title))));
    if (closable.length) await vscode.window.tabGroups.close(closable, true);
    for (const title of this.reviews.keys()) if (!this.findReview(title)) this.reviews.delete(title);
    this.pruneDocuments();
  }

  private pruneDocuments(): void {
    const retained = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()));
    for (const review of this.reviews.values()) for (const entry of review.resources) for (const uri of entry) retained.add(uri.toString());
    for (const key of this.documents.keys()) if (!retained.has(key)) this.documents.delete(key);
  }

  release(uri: vscode.Uri): void {
    if (uri.scheme !== "pi-inmemory-diff") return;
    if ([...this.reviews.values()].some((review) => review.resources.some((entry) => entry.some((resource) => resource.toString() === uri.toString())))) return;
    this.documents.delete(uri.toString());
  }
}
