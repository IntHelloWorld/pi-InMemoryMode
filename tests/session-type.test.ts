import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { MODE_TYPE, STATE_TYPE } from "../src/projection.ts";
import { sessionType } from "../src/session-list.ts";
import { Store } from "../src/store.ts";
import type { SessionTreeOpenEvent } from "../src/tree-api.ts";
import type { Checkpoint } from "../src/types.ts";
import { call, harness, snapshotText } from "./helpers.ts";

type Harness = Awaited<ReturnType<typeof harness>>;

test("inmem commands mount and recover without taking another extension's memory command", async () => {
  const received: string[] = [];
  const h = await harness({ probe: (pi) => {
    pi.registerCommand("memory", {
      description: "Another extension's memory command",
      handler: async (args) => { received.push(args); },
    });
  } });
  try {
    await h.session.prompt("/memory status");
    assert.deepEqual(received, ["status"]);
    assert.equal(h.checkpoints().length, 0);
    await h.session.prompt("/inmem on docs");
    const mounted = h.checkpoints().at(-1)!;
    assert.equal(mounted.kind, "mount");
    assert.equal(mounted.config.root, h.docs);
    await writeFile(join(h.docs, "chapter.md"), "external edit");
    await h.session.prompt("/inmem check");
    await h.session.prompt("/inmem recover");
    assert.equal(await h.text(), "initial\n");
    await h.session.prompt("/memory list");
    assert.deepEqual(received, ["status", "list"]);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

async function tree(h: Harness) {
  const event: SessionTreeOpenEvent = { type: "session_tree_open", tree: h.manager.getTree(),
    currentLeafId: h.manager.getLeafId(), initialFilterMode: "default", skipSummaryPrompt: false };
  await h.session.extensionRunner.emit(event);
  const nodes: SessionTreeNode[] = [];
  const stack = [...event.tree];
  while (stack.length) { const node = stack.pop()!; nodes.push(node); stack.push(...node.children); }
  return nodes;
}

async function legacyOrdinaryRoute(h: Harness) {
  const off: Checkpoint = { ...h.checkpoints().at(-1)!, id: randomUUID(), anchorId: null, enabled: false,
    kind: "off", task: undefined };
  await new Store(off.config).saveCheckpoint(off);
  const offId = h.manager.appendCustomEntry(STATE_TYPE, off);
  const staleNotice = "Legacy switch notice: continue in ordinary mode.";
  h.manager.appendCustomMessageEntry(MODE_TYPE, staleNotice, false, { enabled: false });
  const userId = h.manager.appendMessage({ role: "user", content: "legacy ordinary task", timestamp: Date.now() });
  const report = h.report();
  assert(report.type === "message" && report.message.role === "assistant");
  const reportId = h.manager.appendMessage({ ...report.message, content: [{ type: "text", text: "legacy ordinary reply" }], timestamp: Date.now() });
  return { offId, userId, reportId, staleNotice };
}

test("new sessions become dedicated InMemory sessions; off and rebinding cannot change their category or snapshots", async () => {
  const h = await harness({ persisted: true });
  try {
    await h.mount();
    h.respond([call("managed", "write", { path: "docs/chapter.md", content: "managed body" })], "saved");
    await h.session.prompt("first InMemory task");
    const before = structuredClone(h.manager.getEntries());
    const count = h.requests.length;
    await h.session.prompt("/inmem off");
    await h.session.prompt("/inmem on another-directory");
    assert.deepEqual(h.manager.getEntries(), before);
    assert.equal(h.requests.length, count);
    assert.equal(sessionType(h.manager.getEntries()), "inmemory");
    assert.equal(await h.text(), "managed body");
    h.respond("continued");
    await h.session.prompt("second InMemory task");
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=12\nmanaged body');
    assert.equal(h.checkpoints().at(-1)!.kind, "settled");
    assert(h.checkpoints().every((checkpoint) => checkpoint.enabled));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("ordinary chat cannot be converted; a new empty session can bind the directory", async () => {
  const h = await harness();
  let next: Harness | undefined;
  try {
    h.respond("ordinary reply");
    await h.session.prompt("ordinary task");
    const before = structuredClone(h.manager.getEntries());
    await h.mount();
    assert.deepEqual(h.manager.getEntries(), before);
    assert.equal(sessionType(h.manager.getEntries()), "ordinary");
    assert.equal(h.checkpoints().length, 0);
    h.respond("ordinary continuation");
    await h.session.prompt("continue ordinary chat");
    assert.equal(snapshotText(h.requests.at(-1)!), "");
    next = await harness({ files: {}, existing: { cwd: h.cwd, manager: SessionManager.inMemory(h.cwd) } });
    await next.mount();
    assert.equal(sessionType(next.manager.getEntries()), "inmemory");
    next.respond("dedicated reply");
    await next.session.prompt("dedicated task");
    assert.equal(snapshotText(next.requests.at(-1)!), 'path="chapter.md" bytes=8\ninitial\n');
    assert.deepEqual(h.errors, []);
    assert.deepEqual(next.errors, []);
  } finally { if (next) await next.close(false); await h.close(); }
});

test("legacy off routes remain InMemory, block model requests, preserve files, and recover explicitly from disk", async () => {
  const h = await harness({ persisted: true });
  try {
    await h.mount();
    h.respond("memory report");
    await h.session.prompt("memory task");
    const legacy = await legacyOrdinaryRoute(h);
    await writeFile(join(h.docs, "chapter.md"), "current disk");
    const raw = structuredClone(h.manager.getEntries());
    await h.session.reload();
    assert.equal(sessionType(h.manager.getEntries()), "inmemory");
    assert.deepEqual(h.manager.getEntries(), raw);
    const requestCount = h.requests.length;
    await h.session.prompt("cannot silently continue as ordinary");
    assert.equal(h.requests.length, requestCount);
    assert.equal(await h.text(), "current disk");
    await h.session.prompt("/inmem off");
    assert.equal(h.checkpoints().at(-1)!.enabled, false);
    await h.session.prompt("/inmem sync");
    assert.equal(h.checkpoints().at(-1)!.kind, "external");
    assert.equal(h.checkpoints().at(-1)!.enabled, true);
    h.respond("dedicated continuation");
    await h.session.prompt("continue InMemory");
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=12\ncurrent disk');
    const texts = h.requests.at(-1)!.messages.flatMap((message) => typeof message.content === "string" ? [message.content]
      : message.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : ""));
    assert(texts.includes("legacy ordinary task"));
    assert(!texts.includes(legacy.staleNotice));
    assert(h.manager.getEntries().some((entry) => entry.type === "custom_message" && entry.content === legacy.staleNotice));
    assert.equal(await h.text(), "current disk");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("tree hides and rejects legacy ordinary nodes, while valid InMemory reports remain recoverable", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond([call("a", "write", { path: "docs/chapter.md", content: "A" })], "memory A report");
    await h.session.prompt("memory A task");
    const a = h.report();
    const legacy = await legacyOrdinaryRoute(h);
    await writeFile(join(h.docs, "chapter.md"), "ordinary era file");
    await h.session.reload();
    await h.session.prompt("/inmem sync");
    h.respond("recovered report");
    await h.session.prompt("recovered task");
    const recovered = h.report();
    const view = await tree(h);
    assert(view.some((node) => node.entry.id === a.id));
    assert(view.some((node) => node.entry.id === recovered.id));
    for (const target of [legacy.offId, legacy.userId, legacy.reportId]) {
      assert(!view.some((node) => node.entry.id === target));
      const leaf = h.manager.getLeafId();
      const raw = structuredClone(h.manager.getEntries());
      assert.equal((await h.session.navigateTree(target)).cancelled, true);
      assert.equal(h.manager.getLeafId(), leaf);
      assert.deepEqual(h.manager.getEntries(), raw);
      assert.equal(await h.text(), "ordinary era file");
    }
    await h.session.navigateTree(a.id);
    assert.equal(await h.text(), "A");
    assert.equal(sessionType(h.manager.getEntries()), "inmemory");
    h.respond("new branch reply");
    await h.session.prompt("new InMemory branch");
    const branchTexts = h.requests.at(-1)!.messages.flatMap((message) => typeof message.content === "string" ? [message.content]
      : message.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : ""));
    assert(!branchTexts.includes("legacy ordinary task"));
    await h.session.navigateTree(recovered.id);
    assert.equal(await h.text(), "ordinary era file");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("legacy sessions with unavailable snapshots never fall back to ordinary mode; disk recovery creates usable new versions", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond("memory reply");
    await h.session.prompt("memory task");
    await legacyOrdinaryRoute(h);
    await writeFile(join(h.docs, "chapter.md"), "untracked disk");
    await rm(join(h.cwd, ".pi/inmemory"), { recursive: true, force: true });
    await h.session.reload();
    await h.session.prompt("blocked task");
    assert.equal(h.requests.length, 1);
    assert.equal(sessionType(h.manager.getEntries()), "inmemory");
    assert.equal(await h.text(), "untracked disk");
    await h.session.prompt("/inmem sync");
    h.respond("recovered");
    await h.session.prompt("new task");
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=14\nuntracked disk');
    await h.session.reload();
    h.respond("after restart");
    await h.session.prompt("verify persisted category");
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=14\nuntracked disk');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("ordinary routes before a legacy first mount cannot be selected or resumed as ordinary", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond("memory reply");
    await h.session.prompt("memory task");
    h.manager.resetLeaf();
    const ordinary = h.manager.appendMessage({ role: "user", content: "legacy pre-mount chat", timestamp: Date.now() });
    h.manager.appendSessionInfo("Legacy pre-mount route");
    // The first-mount route still exists in the same session, but isn't an ancestor.
    assert(!h.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === STATE_TYPE));
    await h.session.reload();
    assert.equal(sessionType(h.manager.getEntries()), "inmemory");
    await h.session.prompt("blocked ordinary continuation");
    assert.equal(h.requests.length, 1);
    assert(!(await tree(h)).some((node) => node.entry.id === ordinary));
    const before = h.manager.getLeafId();
    assert.equal((await h.session.navigateTree(ordinary)).cancelled, true);
    assert.equal(h.manager.getLeafId(), before);
    const departure = await h.session.extensionRunner.emit({ type: "session_before_switch", reason: "resume", targetSessionFile: "/other.jsonl" });
    assert.notEqual(departure?.cancel, true);
    await h.session.reload();
    await h.session.prompt("still blocked after reload");
    assert.equal(h.requests.length, 1);
    await h.session.prompt("/inmem sync");
    h.respond("memory continuation");
    await h.session.prompt("resume dedicated operation");
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=8\ninitial\n');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
