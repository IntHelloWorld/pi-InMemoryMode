import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { hash } from "../src/files.ts";
import { call, harness, snapshotText } from "./helpers.ts";

test("reload restores branch state, releases ownership and preserves completed-task projection", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond([call("write", "write", { path: "docs/chapter.md", content: "saved" })], "saved report");
    await h.session.prompt("save");
    await h.session.reload();
    h.respond("reviewed");
    await h.session.prompt("review after reload");
    assert.equal(await h.text(), "saved");
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=5\nsaved');
    assert.equal(h.checkpoints().at(-1)!.omissions.length, 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("idle external edits require explicit acceptance before a task or tree navigation", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond("initial report");
    await h.session.prompt("initial task");
    const initial = h.report();
    await writeFile(join(h.docs, "chapter.md"), "external change");
    const before = h.checkpoints().at(-1)!.workingId;
    await h.session.prompt("blocked outside edit");
    assert.equal(h.requests.length, 1);
    assert.equal(h.checkpoints().at(-1)!.workingId, before);
    await h.session.prompt("/memory sync");
    h.respond("reviewed");
    await h.session.prompt("review outside edit");
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=15\nexternal change');
    await writeFile(join(h.docs, "chapter.md"), "last outside edit");
    assert.equal((await h.session.navigateTree(initial.id)).cancelled, true);
    assert.equal(await h.text(), "last outside edit");
    await h.session.prompt("/memory sync");
    const external = h.manager.getBranch().findLast((entry) => entry.type === "custom" &&
      (entry.data as { kind?: string })?.kind === "external")!;
    await h.session.navigateTree(initial.id);
    assert.equal(await h.text(), "initial\n");
    assert.equal((await h.session.navigateTree(external.id)).cancelled, false);
    assert.equal(await h.text(), "last outside edit");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("summary navigation is canceled before requests, file changes or leaf changes", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond("first report");
    await h.session.prompt("first");
    const first = h.report();
    h.respond("second report");
    await h.session.prompt("second");
    const leaf = h.manager.getLeafId();
    assert.equal((await h.session.navigateTree(first.id, { summarize: true })).cancelled, true);
    assert.equal(h.manager.getLeafId(), leaf);
    assert.equal(h.requests.length, 2);
    assert.equal(await h.text(), "initial\n");
  } finally { await h.close(); }
});

test("missing historical content rejects tree navigation without changing disk or session position", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond([call("a", "write", { path: "docs/chapter.md", content: "A" })], "report A");
    await h.session.prompt("A");
    const a = h.report();
    h.respond([call("b", "write", { path: "docs/chapter.md", content: "B" })], "report B");
    await h.session.prompt("B");
    const leaf = h.manager.getLeafId();
    const storeDir = join(h.cwd, ".pi/inmemory", hash(h.docs).slice(0, 24));
    await rm(join(storeDir, "objects", hash("A")));
    assert.equal((await h.session.navigateTree(a.id)).cancelled, true);
    assert.equal(h.manager.getLeafId(), leaf);
    assert.equal(await h.text(), "B");
  } finally { await h.close(); }
});

test("idle host compaction rebuilds the next task baseline without reviving old content", async () => {
  const h = await harness({ keepRecentTokens: 1 });
  try {
    await h.mount();
    h.respond([call("write", "write", { path: "docs/chapter.md", content: "latest" })], "saved report");
    await h.session.prompt("save latest version");
    h.respond("acknowledged");
    await h.session.prompt("remember the goal");
    h.respond("## Goal\nContinue editing the saved document.\n## Progress\nSaved latest version.",
      "The user asked to remember the goal; the assistant acknowledged it.");
    await h.session.compact();
    assert(h.manager.getBranch().some((entry) => entry.type === "compaction"));
    h.respond("reviewed");
    await h.session.prompt("review after compaction");
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=6\nlatest');
    assert.equal(await h.text(), "latest");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
