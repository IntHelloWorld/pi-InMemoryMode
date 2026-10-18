import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { checkpointEntry, STATE_TYPE } from "../src/projection.ts";
import { Store } from "../src/store.ts";
import type { SessionTreeOpenEvent } from "../src/tree-api.ts";
import type { Checkpoint } from "../src/types.ts";
import { scan } from "../src/files.ts";
import { Workspace } from "../src/workspace.ts";
import { call, harness, snapshotText } from "./helpers.ts";

type Harness = Awaited<ReturnType<typeof harness>>;

async function tree(h: Harness) {
  const event: SessionTreeOpenEvent = { type: "session_tree_open", tree: h.manager.getTree(),
    currentLeafId: h.manager.getLeafId(), initialFilterMode: "default", skipSummaryPrompt: false };
  await h.session.extensionRunner.emit(event);
  const nodes: SessionTreeNode[] = [];
  const stack = [...event.tree];
  while (stack.length) {
    const node = stack.pop()!;
    nodes.push(node);
    stack.push(...node.children);
  }
  return { event, nodes, ids: new Set(nodes.map((node) => node.entry.id)) };
}

async function leave(h: Harness): Promise<void> {
  const result = await h.session.extensionRunner.emit({ type: "session_before_switch", reason: "resume", targetSessionFile: "/other-session.jsonl" });
  assert.notEqual(result?.cancel, true);
}

async function legacySync(h: Harness, source: Checkpoint): Promise<string> {
  const record: Checkpoint = { ...structuredClone(source), id: randomUUID(), kind: "sync", anchorId: null };
  await new Store(record.config).saveCheckpoint(record);
  return h.manager.appendCustomEntry(STATE_TYPE, record);
}

test("resume after tree navigation keeps the selected route without adding visible checkpoint branches", async () => {
  const first = await harness({ persisted: true });
  let current = first;
  let firstClosed = false;
  try {
    await first.mount();
    first.respond([call("a", "write", { path: "docs/chapter.md", content: "A" })], "report A");
    await first.session.prompt("A");
    const a = first.report();
    first.respond([call("b", "write", { path: "docs/chapter.md", content: "B" })], "report B");
    await first.session.prompt("B");
    const b = first.report();
    await first.session.navigateTree(a.id);
    const before = await tree(first);
    await leave(first);
    const savedPosition = first.manager.getLeafEntry()!;
    assert(checkpointEntry(savedPosition));
    assert.equal(savedPosition.data!.kind, "position");
    assert.deepEqual((await tree(first)).ids, before.ids);
    const file = first.manager.getSessionFile()!;
    await first.close(false);
    firstClosed = true;
    current = await harness({ files: {}, existing: { cwd: first.cwd, manager: SessionManager.open(file) } });
    const reopened = await tree(current);
    assert.equal(current.manager.getLeafId(), savedPosition.id);
    assert.equal(reopened.event.currentLeafId, a.id);
    assert.deepEqual(reopened.ids, before.ids);
    assert.equal(await current.text(), "A");
    assert(!current.manager.getBranch().some((entry) => entry.id === b.id));
    assert(reopened.ids.has(b.id));
    await current.session.navigateTree(b.id);
    assert.equal(await current.text(), "B");
    assert.deepEqual(current.errors, []);
  } finally {
    if (current !== first || !firstClosed) await current.close();
    else await rm(first.cwd, { recursive: true, force: true });
  }
});

test("legacy unchanged sync leaves are hidden without rewriting history or losing either branch", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond([call("a", "write", { path: "docs/chapter.md", content: "A" })], "report A");
    await h.session.prompt("A");
    const a = h.report();
    const checkpointA = h.checkpoints().findLast((record) => record.kind === "settled")!;
    h.respond([call("b", "write", { path: "docs/chapter.md", content: "B" })], "report B");
    await h.session.prompt("B");
    const b = h.report();
    await h.session.navigateTree(a.id);
    const expected = (await tree(h)).ids;
    const first = await legacySync(h, checkpointA);
    const second = await legacySync(h, checkpointA);
    const rawBefore = structuredClone(h.manager.getEntries());
    const view = await tree(h);
    assert.deepEqual(view.ids, expected);
    assert(!view.ids.has(first) && !view.ids.has(second));
    assert.equal(view.event.currentLeafId, a.id);
    assert.deepEqual(h.manager.getEntries(), rawBefore);
    assert.equal((await h.session.navigateTree(b.id)).cancelled, false);
    assert.equal(await h.text(), "B");
    assert.equal((await h.session.navigateTree(a.id)).cancelled, false);
    assert.equal(await h.text(), "A");
  } finally { await h.close(); }
});

test("departure saves the route without comparing or accepting external files; explicit sync survives resume", async () => {
  const first = await harness({ persisted: true });
  let current = first;
  let firstClosed = false;
  try {
    await first.mount();
    first.respond("original report");
    await first.session.prompt("remember initial");
    const original = first.report();
    await writeFile(join(first.docs, "chapter.md"), "outside edit");
    const record = first.checkpoints().at(-1)!;
    const pending = await first.session.extensionRunner.emit({ type: "session_before_switch", reason: "resume", targetSessionFile: "/other.jsonl" });
    assert.notEqual(pending?.cancel, true);
    assert.equal(first.checkpoints().at(-1)!.workingId, record.workingId);
    await first.session.prompt("/inmem sync");
    const external = first.manager.getBranch().findLast((entry) => checkpointEntry(entry) && entry.data!.kind === "external")!;
    await leave(first);
    assert.equal(first.manager.getLabel(external.id), "InMemory: External changes");
    const file = first.manager.getSessionFile()!;
    await first.close(false);
    firstClosed = true;
    current = await harness({ files: {}, existing: { cwd: first.cwd, manager: SessionManager.open(file) } });
    const view = await tree(current);
    assert(view.ids.has(external.id));
    assert.equal(view.event.currentLeafId, external.id);
    assert.equal(await current.text(), "outside edit");
    assert.equal((await current.session.navigateTree(original.id)).cancelled, false);
    assert.equal(await current.text(), "initial\n");
    assert.equal((await current.session.navigateTree(external.id)).cancelled, false);
    assert.equal(await current.text(), "outside edit");
    assert.deepEqual(current.errors, []);
  } finally {
    if (current !== first || !firstClosed) await current.close();
    else await rm(first.cwd, { recursive: true, force: true });
  }
});

test("accepting unchanged files is a no-op; legacy real sync still gets a readable label", async () => {
  const h = await harness();
  try {
    await h.mount();
    const raw = structuredClone(h.manager.getEntries());
    await h.session.prompt("/inmem sync");
    assert.deepEqual(h.manager.getEntries(), raw);
    await writeFile(join(h.docs, "chapter.md"), "external");
    const source = h.checkpoints().at(-1)!;
    const { snapshot } = await scan(source.config);
    const store = new Store(source.config);
    await store.saveSnapshot(snapshot);
    const record: Checkpoint = { ...source, id: randomUUID(), kind: "sync", task: undefined,
      workingId: snapshot.id, baselineId: snapshot.id };
    await store.saveCheckpoint(record);
    const realSync = h.manager.appendCustomEntry(STATE_TYPE, record);
    h.manager.appendLabelChange(realSync, "Memory：外部同步");
    const view = await tree(h);
    assert.equal(view.nodes.find((node) => node.entry.id === realSync)?.label, "InMemory: External sync");
    assert.equal(h.manager.getLabel(realSync), "Memory：外部同步", "display translation must preserve raw legacy history");
    assert(view.ids.has(realSync));
  } finally { await h.close(); }
});

test("recover keeps its ready state durable without adding a visible restore point", async () => {
  const first = await harness({ persisted: true });
  let second: Harness | undefined;
  try {
    await first.mount();
    first.respond([call("progress", "write", { path: "docs/chapter.md", content: "saved progress" })], "completed report");
    await first.session.prompt("edit document");
    const report = first.report();
    const before = await tree(first);
    const raw = structuredClone(first.manager.getEntries());
    await writeFile(join(first.docs, "chapter.md"), "discarded outside edit");
    await first.session.prompt("/inmem recover");
    assert.equal(await first.text(), "saved progress");
    assert.deepEqual(first.manager.getEntries().slice(0, raw.length), raw);
    const position = first.manager.getLeafEntry()!;
    assert(checkpointEntry(position));
    assert.equal(position.data!.kind, "position");
    assert(!position.data!.pendingExternal);
    assert.equal(first.manager.getLabel(position.id), undefined);
    const after = await tree(first);
    assert.deepEqual(after.ids, before.ids);
    assert.equal(after.event.currentLeafId, report.id);
    assert.equal(await first.text(), "saved progress");
    assert.equal((await new Store(position.data!.config).pendingTransactions()).length, 0);
    const file = first.manager.getSessionFile()!;
    await first.close(false);
    second = await harness({ files: {}, existing: { cwd: first.cwd, manager: SessionManager.open(file) } });
    assert.deepEqual(second.notices, []);
    assert.equal(second.manager.getLeafId(), position.id);
    const reopened = await tree(second);
    assert.deepEqual(reopened.ids, before.ids);
    assert.equal(reopened.event.currentLeafId, report.id);
    second.respond("new report");
    await second.session.prompt("new task after recover");
    assert.equal(snapshotText(second.requests[0]!), 'path="chapter.md" bytes=14\nsaved progress');
    assert.equal((await second.session.navigateTree(position.id)).cancelled, true);
    assert.equal(await second.text(), "saved progress");
    assert.deepEqual(second.errors, []);
  } finally { if (second) await second.close(); else await first.close(); }
});

test("legacy recovery nodes stay in raw history but disappear from the tree while external versions remain selectable", async () => {
  const first = await harness({ persisted: true });
  let second: Harness | undefined;
  try {
    await first.mount();
    first.respond([call("saved", "write", { path: "docs/chapter.md", content: "B" })], "report B");
    await first.session.prompt("edit B");
    const report = first.report();
    const before = await tree(first);
    const source = first.checkpoints().at(-1)!;
    const recovery: Checkpoint = { ...structuredClone(source), id: randomUUID(), kind: "recovery", anchorId: null,
      task: undefined, baselineId: source.workingId };
    delete recovery.task;
    await new Store(recovery.config).saveCheckpoint(recovery);
    const id = first.manager.appendCustomEntry(STATE_TYPE, recovery);
    first.manager.appendLabelChange(id, "Memory：恢复完成");
    const raw = structuredClone(first.manager.getEntries());
    const hidden = await tree(first);
    assert.deepEqual(hidden.ids, before.ids);
    assert.equal(hidden.event.currentLeafId, report.id);
    assert.deepEqual(first.manager.getEntries(), raw);
    assert.equal((await first.session.navigateTree(id)).cancelled, true);
    assert.equal(await first.text(), "B");
    const file = first.manager.getSessionFile()!;
    await first.close(false);
    second = await harness({ files: {}, existing: { cwd: first.cwd, manager: SessionManager.open(file) } });
    assert.deepEqual((await tree(second)).ids, before.ids);
    assert.deepEqual(second.manager.getEntry(id), raw.find((entry) => entry.id === id));
    assert.equal(second.manager.getLabel(id), "Memory：恢复完成");
    await writeFile(join(second.docs, "chapter.md"), "C");
    await second.session.prompt("/inmem sync");
    const view = await tree(second);
    const external = view.nodes.find((node) => checkpointEntry(node.entry) && node.entry.data!.kind === "external");
    assert(external);
    assert.equal(external.entry.parentId, report.id);
    assert(!view.ids.has(id));
    assert.equal((await second.session.navigateTree(report.id)).cancelled, false);
    assert.equal(await second.text(), "B");
    assert.equal((await second.session.navigateTree(external.entry.id)).cancelled, false);
    assert.equal(await second.text(), "C");
    assert.deepEqual(second.errors, []);
  } finally { if (second) await second.close(); else await first.close(); }
});

for (const state of ["changed-while-away", "pending-decision", "unfinished-journal"] as const) {
  test(`resume loads ${state} without scanning managed files or reporting a new conflict`, async () => {
    const first = await harness({ persisted: true });
    let second: Harness | undefined;
    const disk = Workspace.prototype.disk;
    try {
      await first.mount();
      first.respond(async () => {
        if (state === "pending-decision") await writeFile(join(first.docs, "chapter.md"), "outside during task");
        return "report";
      });
      await first.session.prompt("original task");
      const checkpoint = first.checkpoints().at(-1)!;
      const file = first.manager.getSessionFile()!;
      await first.close(false);
      const store = new Store(checkpoint.config);
      if (state === "changed-while-away") await writeFile(join(first.docs, "chapter.md"), "outside while away");
      if (state === "unfinished-journal") {
        await store.journal(store.transaction(checkpoint.sessionId, "write", checkpoint.workingId, checkpoint.workingId));
      }
      let scans = 0;
      Workspace.prototype.disk = function () { scans++; return disk.call(this); };
      second = await harness({ files: {}, existing: { cwd: first.cwd, manager: SessionManager.open(file) } });
      assert.equal(scans, 0);
      Workspace.prototype.disk = disk;
      assert.deepEqual(second.notices, []);
      assert.equal(second.checkpoints().at(-1)!.id, checkpoint.id);
      assert.equal(second.requests.length, 0);
      const beforeInput = await second.text();
      await second.session.prompt("next instruction");
      assert.equal(second.requests.length, 0);
      assert.equal(await second.text(), beforeInput);
      assert.equal(second.notices.length, 1);
      await second.session.prompt("/inmem recover");
      assert.equal(await second.text(), "initial\n");
      assert.equal(second.requests.length, 0);
      assert.equal(second.editorText, "next instruction");
      assert.equal((await store.pendingTransactions()).length, 0);
      assert(!second.checkpoints().at(-1)!.pendingExternal);
      second.respond("new report");
      await second.session.prompt(second.editorText);
      assert.equal(second.requests.length, 1);
      assert.deepEqual(second.errors, []);
    } finally {
      Workspace.prototype.disk = disk;
      if (second) await second.close(); else await first.close();
    }
  });
}
