import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IdeAction, IdeConnection, IdeRequest, IdeResult, IdeState } from "../src/ide-protocol.ts";
import { call, harness, snapshotText } from "./helpers.ts";

async function setup(options: Parameters<typeof harness>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-ide-test-"));
  process.env.PI_INMEMORY_IDE_DIR = directory;
  const h = await harness({ ...options, persisted: true });
  const connection = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), "utf8")) as IdeConnection;
  const url = `http://127.0.0.1:${connection.port}`;
  async function state(): Promise<IdeState> {
    return (await fetch(`${url}/state`, { headers: { Authorization: `Bearer ${connection.token}` } })).json() as Promise<IdeState>;
  }
  async function request(action: IdeAction): Promise<IdeRequest> {
    const current = await state();
    return { id: randomUUID(), sessionId: current.sessionId, leafId: current.leafId, action };
  }
  async function post(operation: IdeRequest) {
    return fetch(`${url}/command`, { method: "POST", headers: { Authorization: `Bearer ${connection.token}` }, body: JSON.stringify(operation) });
  }
  async function run(action: IdeAction): Promise<IdeResult> {
    const response = await post(await request(action));
    const value = await response.json() as IdeResult & { error?: string };
    assert.equal(response.status, 200, value.error);
    return value;
  }
  return { h, directory, connection, state, request, post, run, url,
    async close() { await h.close(); await rm(directory, { recursive: true, force: true }); delete process.env.PI_INMEMORY_IDE_DIR; } };
}

test("IDE connection authenticates locally, mounts through Pi, and state reads do not accept or scan disk changes", async () => {
  const t = await setup();
  try {
    assert.equal((await stat(join(t.directory, (await readdir(t.directory))[0]!))).mode & 0o777, 0o600);
    assert.equal((await fetch(`${t.url}/state`)).status, 403);
    assert.equal((await fetch(`${t.url}/state`, { headers: { Authorization: `Bearer ${t.connection.token}`, Origin: "https://example.com" } })).status, 403);
    assert.equal((await t.state()).canMount, true);
    await t.run({ type: "mount", directory: t.h.docs });
    const before = await t.state();
    assert.equal(before.root, t.h.docs);
    assert.deepEqual(before.files, ["chapter.md"]);
    await writeFile(join(t.h.docs, "chapter.md"), "external");
    const unread = await t.state();
    assert.equal(unread.workingId, before.workingId);
    assert.equal(unread.checkedAt, before.checkedAt);
    assert.deepEqual(unread.changes, []);
    await t.run({ type: "check" });
    const pending = await t.state();
    assert.equal(pending.mode, "needs-recovery");
    assert.deepEqual(pending.changes.map(({ path, kind }) => ({ path, kind })), [{ path: "chapter.md", kind: "modified" }]);
    assert.equal(pending.workingId, before.workingId);
    const { diff } = await t.run({ type: "diff", path: "chapter.md", workingId: pending.workingId!, externalSnapshotId: pending.externalSnapshotId! });
    assert.equal(diff?.before, "initial\n");
    assert.equal(diff?.after, "external");
    await t.run({ type: "sync", workingId: pending.workingId!, externalSnapshotId: pending.externalSnapshotId });
    assert.equal((await t.state()).mode, "ready");
    assert.equal(t.h.requests.length, 0);
    assert.deepEqual(t.h.errors, []);
  } finally { await t.close(); }
});

test("IDE retries run once; stale session/branch requests and changed disk decisions are rejected", async () => {
  const t = await setup();
  try {
    const mount = await t.request({ type: "mount", directory: t.h.docs });
    assert.equal((await t.post(mount)).status, 200);
    const count = t.h.checkpoints().length;
    assert.equal((await t.post(mount)).status, 200);
    assert.equal(t.h.checkpoints().length, count);
    const stale = await t.request({ type: "selection", text: "do not deliver", destination: "draft" });
    t.h.respond("done");
    await t.h.session.prompt("move the branch");
    assert.equal((await t.post(stale)).status, 409);
    assert.equal(t.h.editorText, "");
    const wrongSession = await t.request({ type: "check" });
    wrongSession.sessionId = randomUUID();
    assert.equal((await t.post(wrongSession)).status, 409);
    await writeFile(join(t.h.docs, "chapter.md"), "first external");
    await t.run({ type: "check" });
    const pending = await t.state();
    const decision = await t.request({ type: "recover", workingId: pending.workingId!, externalSnapshotId: pending.externalSnapshotId });
    await writeFile(join(t.h.docs, "chapter.md"), "second external");
    assert.equal((await t.post(decision)).status, 409);
    assert.equal(await t.h.text(), "second external");
    const latest = await t.state();
    assert.notEqual(latest.externalSnapshotId, pending.externalSnapshotId);
    await t.run({ type: "recover", workingId: latest.workingId!, externalSnapshotId: latest.externalSnapshotId });
    assert.equal(await t.h.text(), "initial\n");
    assert.equal((await t.state()).mode, "ready");
  } finally { await t.close(); }
});

test("IDE selections preserve existing drafts, survive reload, and only explicit send starts a normal frozen task", async () => {
  const t = await setup();
  try {
    await t.run({ type: "mount", directory: t.h.docs });
    const first = await t.run({ type: "selection", text: "selected source", destination: "draft" });
    assert.equal(first.disposition, "draft");
    const second = await t.run({ type: "selection", text: "additional source", destination: "send" });
    assert.equal(second.disposition, "draft");
    assert.equal(t.h.editorText, "selected source\n\nadditional source");
    assert.equal(t.h.requests.length, 0);
    await t.h.session.reload();
    assert.equal(t.h.editorText, "selected source\n\nadditional source");
    t.h.respond("used selection");
    await t.h.session.prompt(t.h.editorText);
    assert.equal(t.h.requests.length, 1);
    assert.equal(snapshotText(t.h.requests[0]!), 'path="chapter.md" bytes=8\ninitial\n');
    assert.deepEqual(t.h.errors, []);
  } finally { await t.close(); }
});

test("direct IDE send reaches normal input hooks and the baseline; busy selections remain a next-task draft", async () => {
  const t = await setup();
  try {
    await t.run({ type: "mount", directory: t.h.docs });
    let entered!: () => void;
    let release!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    t.h.respond(async () => { entered(); await finish; return "done"; });
    const result = await t.run({ type: "selection", text: "use selected lines", destination: "send" });
    assert.equal(result.disposition, "submitted");
    await running;
    assert.equal((await t.state()).busy, true);
    assert.equal(snapshotText(t.h.requests[0]!), 'path="chapter.md" bytes=8\ninitial\n');
    const queued = await t.run({ type: "selection", text: "for later", destination: "send" });
    assert.equal(queued.disposition, "draft");
    release();
    await t.h.session.waitForIdle();
    assert.equal(t.h.requests.length, 1);
    assert.equal(t.h.editorText, "for later");
    assert.deepEqual(t.h.errors, []);
  } finally { await t.close(); }
});

test("deleted/added files remain reviewable, invalid paths cannot read outside snapshots, and exit removes discovery", async () => {
  const t = await setup();
  try {
    await t.run({ type: "mount", directory: t.h.docs });
    await unlink(join(t.h.docs, "chapter.md"));
    await writeFile(join(t.h.docs, "new.md"), "new");
    await t.run({ type: "check" });
    const state = await t.state();
    assert.deepEqual(state.changes.map(({ path, kind }) => ({ path, kind })), [{ path: "chapter.md", kind: "deleted" }, { path: "new.md", kind: "added" }]);
    const version = { workingId: state.workingId!, externalSnapshotId: state.externalSnapshotId! };
    const batch = await t.run({ type: "diffs", ...version });
    assert.deepEqual(batch.diffs?.map(({ path, beforeExists, afterExists }) => ({ path, beforeExists, afterExists })),
      [{ path: "chapter.md", beforeExists: true, afterExists: false }, { path: "new.md", beforeExists: false, afterExists: true }]);
    assert.equal(batch.diffs?.[0]?.before, "initial\n");
    assert.equal(batch.diffs?.[1]?.after, "new");
    const removed = await t.run({ type: "diff", path: "chapter.md", ...version });
    assert.equal(removed.diff?.afterExists, false);
    assert.equal(removed.diff?.before, "initial\n");
    const added = await t.run({ type: "diff", path: "new.md", ...version });
    assert.equal(added.diff?.beforeExists, false);
    assert.equal(added.diff?.after, "new");
    assert.equal((await t.post(await t.request({ type: "diff", path: "../outside.md", ...version }))).status, 409);
    await t.h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(await readdir(t.directory), []);
  } finally { await t.close(); }
});

test("IDE context added during an interrupted task is preserved alongside Pi's restored submission", async () => {
  const t = await setup();
  try {
    await t.run({ type: "mount", directory: t.h.docs });
    await writeFile(join(t.h.docs, "chapter.md"), "external");
    await t.h.session.prompt("original task");
    assert.equal(t.h.requests.length, 0);
    await t.run({ type: "selection", text: "context from editor", destination: "draft" });
    const state = await t.state();
    await t.run({ type: "recover", workingId: state.workingId!, externalSnapshotId: state.externalSnapshotId });
    assert.equal(t.h.editorText, "original task\n\ncontext from editor");
    assert.equal(t.h.requests.length, 0);
  } finally { await t.close(); }
});

test("ordinary-session editor drafts include pre-existing input on reload and are consumed once submitted", async () => {
  const t = await setup({ probe: (pi) => {
    pi.registerCommand("test-editor", { handler: async (text, ctx) => { ctx.ui.setEditorText(text); } });
  } });
  try {
    await t.h.session.prompt("/test-editor existing instruction");
    await t.run({ type: "selection", text: "selected source", destination: "draft" });
    await t.h.session.prompt("/test-editor");
    await t.h.session.reload();
    assert.equal(t.h.editorText, "existing instruction\n\nselected source");
    t.h.respond("ordinary reply");
    await t.h.session.prompt(t.h.editorText);
    await t.h.session.prompt("/test-editor");
    await t.h.session.reload();
    assert.equal(t.h.editorText, "");
    assert.equal(t.h.requests.length, 1);
    assert.deepEqual(t.h.errors, []);
  } finally { await t.close(); }
});
