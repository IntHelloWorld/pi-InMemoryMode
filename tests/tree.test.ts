import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme, InteractiveMode, TreeSelectorComponent, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { hash } from "../src/files.ts";
import type { SessionTreeOpenEvent } from "../src/tree-api.ts";
import { call, harness } from "./helpers.ts";

function nodes(tree: SessionTreeNode[]): SessionTreeNode[] {
  const result: SessionTreeNode[] = [];
  const stack = [...tree].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    result.push(node);
    stack.push(...[...node.children].reverse());
  }
  return result;
}

async function openTree(h: Awaited<ReturnType<typeof harness>>): Promise<SessionTreeOpenEvent> {
  const event: SessionTreeOpenEvent = { type: "session_tree_open", tree: h.manager.getTree(),
    currentLeafId: h.manager.getLeafId(), initialFilterMode: "default", skipSummaryPrompt: false };
  await h.session.extensionRunner.emit(event);
  return event;
}

test("tree displays only recoverable targets; tool nodes stay hidden even in all/labeled views", async () => {
  const h = await harness();
  try {
    await h.mount();
    const mount = h.manager.getBranch().find((entry) => entry.type === "custom")!;
    h.respond([call("write", "write", { path: "docs/chapter.md", content: "updated" })], "saved report");
    await h.session.prompt("save document");
    const report = h.report();
    const rawTree = structuredClone(h.manager.getTree());
    const tool = h.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult")!;
    h.manager.appendLabelChange(tool.id, "manually labeled tool");
    const rawBefore = structuredClone(h.manager.getEntries());
    const event = await openTree(h);
    const displayed = nodes(event.tree);
    assert.equal(event.skipSummaryPrompt, true);
    assert.equal(event.initialFilterMode, "all");
    assert.equal(event.currentLeafId, report.id);
    assert(displayed.some((node) => node.entry.id === mount.id));
    assert(displayed.some((node) => node.entry.id === report.id));
    assert(displayed.some((node) => node.entry.type === "message" && node.entry.message.role === "user"));
    assert(!displayed.some((node) => node.entry.id === tool.id));
    assert(!displayed.some((node) => node.entry.type === "message" && node.entry.message.role === "assistant" &&
      node.entry.message.content.some((block) => block.type === "toolCall")));
    initTheme("dark", false);
    const selector = new TreeSelectorComponent(event.tree, event.currentLeafId, 30, () => {}, () => {},
      undefined, undefined, event.initialFilterMode);
    selector.handleInput("\x01"); // Ctrl+A: all entries cannot reintroduce the removed tools.
    const visited = new Set<string>();
    for (let i = 0; i < displayed.length * 2; i++) {
      const selected = selector.getTreeList().getSelectedNode();
      if (selected) visited.add(selected.entry.id);
      selector.handleInput("\x1b[B");
    }
    assert.deepEqual(visited, new Set(displayed.map((node) => node.entry.id)));
    selector.handleInput("\x0c"); // Ctrl+L: a manually labeled tool is still unavailable.
    assert.notEqual(selector.getTreeList().getSelectedNode()?.entry.id, tool.id);
    assert.deepEqual(h.manager.getEntries(), rawBefore);
    const leaf = h.manager.getLeafId();
    assert.equal((await h.session.navigateTree(tool.id)).cancelled, true);
    assert.equal(h.manager.getLeafId(), leaf);
    assert.equal(await h.text(), "updated");
    assert.equal(nodes(rawTree).length, rawBefore.length - 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("native tree selection skips the summary dialog and restores the selected report", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond([call("a", "write", { path: "docs/chapter.md", content: "A" })], "checkpoint-alpha");
    await h.session.prompt("A");
    const a = h.report();
    h.respond([call("b", "write", { path: "docs/chapter.md", content: "B" })], "report B");
    await h.session.prompt("B");
    let selector: TreeSelectorComponent | undefined;
    let prompts = 0;
    const errors: string[] = [];
    initTheme("dark", false);
    // Exercise the actual patched host method, with terminal drawing replaced by a small harness.
    const host = {
      sessionManager: h.manager, session: h.session,
      settingsManager: { getTreeFilterMode: () => "default", getBranchSummarySkipPrompt: () => false },
      ui: { terminal: { rows: 30 }, requestRender: () => {} },
      showSelector: (factory: (done: () => void) => { component: TreeSelectorComponent }) => { selector = factory(() => {}).component; },
      showExtensionSelector: async () => { prompts++; return "No summary"; },
      defaultEditor: { onEscape: undefined }, editor: { getText: () => "", setText: () => {} },
      chatContainer: { clear: () => {} }, renderInitialMessages: () => {},
      showStatus: () => {}, showError: (error: string) => errors.push(error), flushCompactionQueue: async () => {},
    };
    const show = Reflect.get(InteractiveMode.prototype, "showTreeSelector") as (this: typeof host) => Promise<void>;
    await show.call(host);
    assert(selector);
    selector.handleInput("checkpoint-alpha");
    const list = selector.getTreeList();
    assert.equal(list.getSelectedNode()?.entry.id, a.id);
    await list.onSelect!(a.id);
    assert.equal(prompts, 0);
    assert.equal(await h.text(), "A");
    assert.equal(h.requests.length, 4);
    assert.deepEqual(errors, []);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("tree filtering preserves both branch routes and hides checkpoints with missing objects", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond([call("a", "write", { path: "docs/chapter.md", content: "A" })], "report A");
    await h.session.prompt("A");
    const a = h.report();
    h.respond([call("b", "write", { path: "docs/chapter.md", content: "B" })], "report B");
    await h.session.prompt("B");
    const b = h.report();
    await h.session.navigateTree(a.id);
    h.respond([call("c", "write", { path: "docs/chapter.md", content: "C" })], "report C");
    await h.session.prompt("C");
    const c = h.report();
    const view = nodes((await openTree(h)).tree);
    for (const report of [a, b, c]) assert(view.some((node) => node.entry.id === report.id));
    const branches = view.filter((node) => node.entry.type === "message" && node.entry.message.role === "user" && node.entry.parentId === a.id);
    assert.equal(branches.length, 2);
    const store = join(h.cwd, ".pi/inmemory", hash(h.docs).slice(0, 24));
    await rm(join(store, "objects", hash("B")));
    const safe = nodes((await openTree(h)).tree);
    assert(!safe.some((node) => node.entry.id === b.id));
    assert(safe.some((node) => node.entry.id === c.id));
    assert.equal(await h.text(), "C");
  } finally { await h.close(); }
});

test("sessions without memory history keep the host's tree and summary preference", async () => {
  const h = await harness();
  try {
    h.respond("ordinary reply");
    await h.session.prompt("ordinary chat");
    const original = h.manager.getTree();
    const event = await openTree(h);
    assert.equal(event.skipSummaryPrompt, false);
    assert.equal(event.initialFilterMode, "default");
    assert.deepEqual(event.tree, original);
  } finally { await h.close(); }
});
