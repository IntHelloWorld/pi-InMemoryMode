import assert from "node:assert/strict";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import type { InMemoryApi } from "../src/extension.ts";
import { Sessions } from "../src/sessions.ts";
import { applyReviewDecision } from "../src/review.ts";
import { FilesView } from "../src/views.ts";

async function until(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${description}`);
}

function reviewTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
    const input = tab.input as { textDiffs?: vscode.TabInputTextDiff[] } | undefined;
    return input?.textDiffs?.length && input.textDiffs.every((diff) => diff.original.scheme === "pi-inmemory-diff");
  });
}

export async function run(): Promise<void> {
  const cwd = process.env.PI_IDE_TEST_WORKSPACE!;
  const extension = vscode.extensions.getExtension<InMemoryApi>("IntHelloWorld.pi-inmemory-vscode")!;
  assert(extension);
  const api = await extension.activate();
  await until(async () => { await api.refresh(); return api.getSelectedState()?.root === join(cwd, "docs"); }, "connect to real Pi SDK fixture");
  const commands = await vscode.commands.getCommands(true);
  for (const name of ["mount", "sendSelection", "addSelection", "check", "sync", "continue", "recover", "diff", "diffAll", "showLogs"]) assert(commands.includes(`piInMemory.${name}`));
  await vscode.commands.executeCommand("piInMemory.showLogs");

  const uri = vscode.Uri.file(join(cwd, "docs/chapter.md"));
  const editor = await vscode.window.showTextDocument(uri);
  editor.selection = new vscode.Selection(0, 0, 0, 7);
  await vscode.commands.executeCommand("piInMemory.sendSelection");
  await until(async () => (await readFile(uri.fsPath, "utf8")) === "from VS Code\n", "selection starts a real Pi input/tool lifecycle");
  await until(async () => { await api.refresh(); return api.getSelectedState()?.busy === false; }, "task settles");

  await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "unsaved "));
  editor.selection = new vscode.Selection(0, 0, 0, 7);
  await vscode.commands.executeCommand("piInMemory.addSelection");
  assert.equal(editor.document.isDirty, true);
  assert.equal(await readFile(uri.fsPath, "utf8"), "from VS Code\n");
  await vscode.commands.executeCommand("workbench.action.files.revert");

  await writeFile(uri.fsPath, "external in VS Code test\n");
  await unlink(join(cwd, "docs/delete.md"));
  await vscode.commands.executeCommand("piInMemory.check");
  assert.equal(api.getSelectedState()?.mode, "needs-recovery");
  assert.deepEqual(api.getSelectedState()?.changes.map(({ path, kind }) => ({ path, kind })),
    [{ path: "chapter.md", kind: "modified" }, { path: "delete.md", kind: "deleted" }]);
  await until(async () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => {
    const input = tab.input as { textDiffs?: vscode.TabInputTextDiff[] } | undefined;
    return input?.textDiffs?.length === 2 && input.textDiffs.every((diff) => diff.original.scheme === "pi-inmemory-diff");
  }), "all pending files open automatically in one native changes editor");
  const firstReview = reviewTabs()[0]!;
  for (let click = 0; click < 3; click++) await vscode.commands.executeCommand("piInMemory.diffAll");
  assert.equal(reviewTabs().length, 1, "repeated clicks reuse one review");
  assert.equal(reviewTabs()[0], firstReview, "reuse preserves the existing editor and its view state");
  await vscode.commands.executeCommand("piInMemory.diff", uri);
  assert(vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) =>
    tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === "pi-inmemory-diff" && tab.input.modified.toString() === uri.toString()));
  await vscode.commands.executeCommand("piInMemory.diff", uri);
  assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) =>
    tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === "pi-inmemory-diff").length, 1, "single-file reviews reuse their editor too");

  // Drive the same decision coordinator as the toolbar with a simulated human confirmation.
  // Files and editors are real; no native modal needs manual intervention in this isolated test window.
  const reviewSessions = new Sessions({ info() {}, warn() {}, error() {} });
  const reviewFiles = new FilesView(reviewSessions);
  async function assertReviewActions(available = true): Promise<void> {
    await reviewSessions.refresh();
    const actions = reviewFiles.getChildren().filter((node) => node.kind === "action").map((node) => reviewFiles.getTreeItem(node).command?.command);
    assert.deepEqual(actions, available ? ["piInMemory.continue", "piInMemory.recover"] : []);
  }
  try {
    await assertReviewActions();
    const resultEditor = await vscode.window.showTextDocument(uri);
    await resultEditor.edit((edit) => edit.replace(new vscode.Range(0, 0, resultEditor.document.lineCount, 0), "resolved in IDE\n"));
    assert.equal(resultEditor.document.isDirty, true);
    await assertReviewActions();
    await Promise.all(Array.from({ length: 3 }, () => vscode.commands.executeCommand("piInMemory.diffAll")));
    assert.equal(reviewTabs().length, 1, "rapid clicks do not duplicate a dirty review");
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab, firstReview, "open all reveals the existing review");
    assert.equal(resultEditor.document.getText(), "resolved in IDE\n");
    assert.equal(resultEditor.document.isDirty, true, "opening a review does not save edits");
    assert.equal(await readFile(uri.fsPath, "utf8"), "external in VS Code test\n");
    const label = reviewTabs()[0]!.label;
    await vscode.window.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    await vscode.commands.executeCommand("piInMemory.diffAll");
    assert.equal(reviewTabs().length, 1, "switching editor groups does not duplicate the review");
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.label, label);
    assert.equal(resultEditor.document.isDirty, true);
    // Saving is still an external edit: neither action disappears until an explicit decision.
    await resultEditor.document.save();
    await assertReviewActions();
    await vscode.commands.executeCommand("piInMemory.diffAll");
    assert.equal(reviewTabs().length, 1, "saving does not create a new review");
    await vscode.window.tabGroups.close(reviewTabs()[0]!, true);
    await vscode.commands.executeCommand("piInMemory.diffAll");
    assert.equal(reviewTabs().length, 1, "a manually closed review can be reopened");
    const reopened = reviewTabs()[0]!.input as { textDiffs: vscode.TabInputTextDiff[] };
    const original = reopened.textDiffs.find((diff) => diff.modified.toString() === uri.toString())!.original;
    assert.equal((await vscode.workspace.openTextDocument(original)).getText(), "from VS Code\n", "reopening preserves the Pi baseline");
    const openResult = await vscode.window.showTextDocument(uri, { preview: false });
    await openResult.edit((edit) => edit.insert(new vscode.Position(0, 0), "saved by Continue "));
    assert.equal(await applyReviewDecision(reviewSessions, "continue", async () => true), true);
    assert.equal(resultEditor.document.isDirty, false);
    assert.equal(await readFile(uri.fsPath, "utf8"), "saved by Continue resolved in IDE\n");
    assert.equal(reviewSessions.selected?.state.mode, "ready");
    assert.deepEqual(reviewSessions.selected?.state.files, ["chapter.md"]);
    await assertReviewActions(false);

    await writeFile(uri.fsPath, "external to discard\n");
    await vscode.commands.executeCommand("piInMemory.check");
    await reviewSessions.refresh();
    await until(async () => resultEditor.document.getText() === "external to discard\n", "editor reloads external change");
    await until(async () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) =>
      (tab.input as { textDiffs?: vscode.TabInputTextDiff[] } | undefined)?.textDiffs?.length === 1), "second pending episode opens its own review");
    const discardEditor = await vscode.window.showTextDocument(uri, { preview: false });
    await discardEditor.edit((edit) => edit.insert(new vscode.Position(0, 0), "unsaved "));
    await assertReviewActions();
    await writeFile(join(cwd, "docs/new.md"), "new pending file\n");
    await vscode.commands.executeCommand("piInMemory.check");
    await vscode.commands.executeCommand("piInMemory.diffAll");
    assert.equal(reviewTabs().length, 1, "a changed file list replaces its review instead of duplicating it");
    assert.equal((reviewTabs()[0]!.input as { textDiffs: vscode.TabInputTextDiff[] }).textDiffs.length, 2);
    assert.equal(discardEditor.document.getText(), "unsaved external to discard\n");
    assert.equal(discardEditor.document.isDirty, true, "refreshing the file list preserves unsaved edits");
    assert.equal(await readFile(uri.fsPath, "utf8"), "external to discard\n");
    assert.equal(await applyReviewDecision(reviewSessions, "recover", async () => false), false);
    assert.equal(discardEditor.document.isDirty, true);
    await assertReviewActions();
    assert.equal(await readFile(uri.fsPath, "utf8"), "external to discard\n");
    assert.equal(await applyReviewDecision(reviewSessions, "recover", async () => true), true);
    assert.equal(discardEditor.document.isDirty, false);
    assert.equal(await readFile(uri.fsPath, "utf8"), "saved by Continue resolved in IDE\n");
    assert.equal(reviewSessions.selected?.state.mode, "ready");
    await assertReviewActions(false);
  } finally { reviewFiles.dispose(); reviewSessions.dispose(); }

  // Exercise the Pi executable's env-node shebang with a minimal GUI PATH, rather than bypassing it with Node.
  const config = vscode.workspace.getConfiguration("piInMemory");
  await config.update("executable", process.env.PI_IDE_TEST_PI!, vscode.ConfigurationTarget.Global);
  await config.update("nodeExecutable", "", vscode.ConfigurationTarget.Global);
  await config.update("pluginPath", process.env.PI_IDE_TEST_REPO!, vscode.ConfigurationTarget.Global);
  await config.update("arguments", ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"], vscode.ConfigurationTarget.Global);
  const another = join(cwd, "another");
  await mkdir(another);
  await writeFile(join(another, "note.md"), "terminal mount\n");
  await vscode.commands.executeCommand("piInMemory.mount", vscode.Uri.file(another));
  assert.equal(api.getSelectedState()?.root, another);
  assert.deepEqual(api.getSelectedState()?.files, ["note.md"]);
  assert(vscode.window.terminals.some((terminal) => terminal.name === "Pi InMemory"));
  await vscode.commands.executeCommand("piInMemory.focus");
  const terminal = vscode.window.activeTerminal!;
  terminal.dispose();
  await until(async () => { await api.refresh(); return !api.getSelectedState() || api.getSelectedState()?.root !== another; }, "terminal exit disconnects and clears decorations");
  console.log("Pi InMemory extension host: connection, output, selection, reusable multi/single-file reviews, rapid clicks, cross-group focus, reopen, dirty-file refresh, Continue, cancelled/confirmed Recover and minimal-PATH Pi terminal mount passed.");
}
