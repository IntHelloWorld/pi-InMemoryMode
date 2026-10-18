import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hash } from "../src/files.ts";
import { call, harness, snapshotText } from "./helpers.ts";

test("real Pi lifecycle freezes baseline, reads live memory, compresses only completed raw calls", async () => {
  const h = await harness({ persisted: true });
  try {
    await h.mount();
    h.respond([call("w1", "write", { path: "docs/chapter.md", content: "draft\n" })],
      [call("e1", "edit", { path: "docs/chapter.md", edits: [{ oldText: "draft", newText: "final" }] })],
      [call("r1", "read", { path: "docs/chapter.md" })], "done");
    await h.session.prompt("write first draft");
    assert.equal(await h.text(), "final\n");
    assert.equal(h.requests.length, 4);
    for (const request of h.requests) assert.equal(snapshotText(request), 'path="chapter.md" bytes=8\ninitial\n');
    assert.deepEqual(h.requests[1]!.messages.slice(0, h.requests[0]!.messages.length), h.requests[0]!.messages);
    const readResult = h.requests[3]!.messages.find((message) => message.role === "toolResult" && message.toolCallId === "r1");
    assert(readResult?.role === "toolResult");
    assert.equal(readResult.content[0]?.type === "text" && readResult.content[0].text, "final\n");
    const rawBefore = structuredClone(h.manager.getEntries().filter((entry) => entry.type === "message"));
    const completedTask = h.checkpoints().at(-1)!;
    h.respond("second done");
    await h.session.prompt("review it");
    assert.equal(snapshotText(h.requests[4]!), 'path="chapter.md" bytes=6\nfinal\n');
    const historyCall = h.requests[4]!.messages.flatMap((message) => message.role === "assistant" ? message.content : [])
      .find((block) => block.type === "toolCall" && block.id === "w1");
    assert(historyCall?.type === "toolCall");
    assert.deepEqual(historyCall.arguments, { path: "docs/chapter.md", content: "[历史正文已省略]" });
    const historyEdit = h.requests[4]!.messages.flatMap((message) => message.role === "assistant" ? message.content : [])
      .find((block) => block.type === "toolCall" && block.id === "e1");
    assert(historyEdit?.type === "toolCall");
    assert.deepEqual(historyEdit.arguments, { path: "docs/chapter.md", edits: [{ oldText: "[历史正文已省略]", newText: "[历史正文已省略]" }] });
    const compactResult = h.requests[4]!.messages.find((message) => message.role === "toolResult" && message.toolCallId === historyCall.id);
    assert(compactResult?.role === "toolResult");
    assert.equal(compactResult.isError, false);
    assert.deepEqual(compactResult.content, [{ type: "text", text: "已成功。" }]);
    // The short model-facing marker still resolves to full recovery metadata and original bytes.
    const omission = h.checkpoints().at(-1)!.omissions.find((item) => item.callId === historyCall.id)!;
    const source = h.manager.getEntry(omission.entryId);
    assert(source?.type === "message" && source.message.role === "assistant");
    const originalCall = source.message.content.find((block) => block.type === "toolCall" && block.id === omission.callId);
    assert(originalCall?.type === "toolCall");
    assert.equal(originalCall.arguments.content, "draft\n");
    const storeDirectory = join(h.cwd, ".pi/inmemory", hash(h.docs).slice(0, 24));
    const manifest = JSON.parse(await readFile(join(storeDirectory, "manifests", omission.snapshotId), "utf8"));
    assert.equal(await readFile(join(storeDirectory, "objects", manifest.files[omission.path].hash), "utf8"), "draft\n");
    assert.equal(omission.baselineId, h.checkpoints().at(-1)!.baselineId);
    assert.equal(omission.taskId, completedTask.task!.id);
    const rawAfter = h.manager.getEntries().filter((entry) => entry.type === "message").slice(0, rawBefore.length);
    assert.deepEqual(rawAfter, rawBefore);
    const persisted = await readFile(h.manager.getSessionFile()!, "utf8");
    const persistedWrite = persisted.trim().split("\n").map((line) => JSON.parse(line))
      .find((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((block: { id?: string }) => block.id === "w1"));
    assert.equal(persistedWrite.message.content[0].arguments.content, "draft\n");
    assert.equal(h.checkpoints().at(-1)!.task?.status, "completed");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("native tree restores reports, user instruction parents and both branches", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond([call("a", "write", { path: "docs/chapter.md", content: "A" })], "report A");
    await h.session.prompt("task A");
    const a = h.report();
    h.respond([call("b", "write", { path: "docs/chapter.md", content: "B" })], "report B");
    await h.session.prompt("task B");
    const b = h.report();
    const userB = h.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user" &&
      Array.isArray(entry.message.content) && entry.message.content.some((block) => block.type === "text" && block.text === "task B"))!;
    assert.equal((await h.session.navigateTree(userB.id)).cancelled, false);
    assert.equal(await h.text(), "A");
    h.respond([call("c", "write", { path: "docs/chapter.md", content: "C" })], "report C");
    await h.session.prompt("alternate task");
    const c = h.report();
    assert.equal(await h.text(), "C");
    assert.equal((await h.session.navigateTree(b.id)).cancelled, false);
    assert.equal(await h.text(), "B");
    assert.equal((await h.session.navigateTree(c.id)).cancelled, false);
    assert.equal(await h.text(), "C");
    assert.equal((await h.session.navigateTree(a.id)).cancelled, false);
    assert.equal(await h.text(), "A");
    h.respond("review A");
    await h.session.prompt("review this branch");
    const latest = h.requests.at(-1)!;
    assert.equal(snapshotText(latest), 'path="chapter.md" bytes=1\nA');
    const branchCalls = latest.messages.flatMap((message) => message.role === "assistant" ? message.content : []).filter((block) => block.type === "toolCall");
    assert.deepEqual(branchCalls.map((block) => block.type === "toolCall" && block.id), ["a"]);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("create, move, delete and tree restore retain bytes, BOM, CRLF and file set", async () => {
  const h = await harness({ files: { "chapter.md": Buffer.from("\uFEFFalpha\r\nbeta\r\n") } });
  try {
    await h.mount();
    h.respond("initial report");
    await h.session.prompt("remember initial");
    const initial = h.report();
    h.respond([call("edit", "edit", { path: "docs/chapter.md", edits: [{ oldText: "beta", newText: "gamma" }] })],
      [call("create", "write", { path: "docs/new.md", content: "new" })],
      [call("move", "memory_move", { from: "docs/new.md", to: "docs/nested/moved.md" })],
      [call("delete", "memory_delete", { path: "docs/chapter.md" })], "modified report");
    await h.session.prompt("modify files");
    await assert.rejects(h.text(), { code: "ENOENT" });
    assert.equal(await h.text("nested/moved.md"), "new");
    const final = h.report();
    await h.session.navigateTree(initial.id);
    assert.equal(await h.text(), "\uFEFFalpha\r\nbeta\r\n");
    await assert.rejects(h.text("nested/moved.md"), { code: "ENOENT" });
    await h.session.navigateTree(final.id);
    assert.equal(await h.text("nested/moved.md"), "new");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("external mutation during a read is detected at settlement and blocks new requests until explicit recovery", async () => {
  const h = await harness({ probe: (pi) => {
    pi.on("tool_execution_end", async (event, ctx) => {
      if (event.toolCallId === "external") await writeFile(join(ctx.cwd, "docs/chapter.md"), "external");
    });
  } });
  try {
    await h.mount();
    h.respond([call("external", "read", { path: "docs/chapter.md" })], "report based on frozen memory");
    await h.session.prompt("check");
    assert.equal(await h.text(), "external");
    assert.equal(h.requests.length, 2);
    assert.equal(h.checkpoints().at(-1)!.task?.status, "incomplete");
    assert.equal(h.checkpoints().at(-1)!.pendingExternal, true);
    await h.session.prompt("blocked");
    assert.equal(h.requests.length, 2);
    await h.session.prompt("/memory sync");
    h.respond("recovered");
    await h.session.prompt("continue");
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=8\nexternal');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("restart preserves conflicting disk and allows restoring checkpoint", async () => {
  const first = await harness({ persisted: true });
  let second: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await first.mount();
    first.respond([call("save", "write", { path: "docs/chapter.md", content: "saved" })], "saved report");
    await first.session.prompt("save");
    const file = first.manager.getSessionFile()!;
    await first.close(false);
    await writeFile(join(first.docs, "chapter.md"), "edited while away");
    second = await harness({ files: {}, existing: { cwd: first.cwd, manager: SessionManager.open(file) } });
    assert.equal(await second.text(), "edited while away");
    await second.session.prompt("blocked");
    assert.equal(second.requests.length, 0);
    await second.session.prompt("/memory recover");
    assert.equal(await second.text(), "saved");
    second.respond("continue report");
    await second.session.prompt("continue");
    assert.equal(snapshotText(second.requests[0]!), 'path="chapter.md" bytes=5\nsaved');
    assert.deepEqual(second.errors, []);
  } finally { if (second) await second.close(); else await first.close(); }
});

test("capacity failures actually cancel before a provider request, without truncating files", async () => {
  const h = await harness({ contextWindow: 1800 });
  try {
    await h.mount();
    h.respond("must not execute");
    await h.session.prompt("edit");
    assert.equal(h.requests.length, 0);
    assert.equal(await h.text(), "initial\n");
    assert(h.abortedRequests > 0 || h.notices.some((notice) => notice.includes("容量") || notice.includes("预算")));
  } finally { await h.close(); }
});

test("symlinks and unsupported intermediate tree targets cannot restore outside files", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond([call("write", "write", { path: "docs/chapter.md", content: "new" })], "new report");
    await h.session.prompt("write");
    const middle = h.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "toolUse")!;
    assert.equal((await h.session.navigateTree(middle.id)).cancelled, true);
    assert.equal(await h.text(), "new");
    await writeFile(join(h.cwd, "outside.md"), "outside");
    await rm(join(h.docs, "chapter.md"));
    await symlink(join(h.cwd, "outside.md"), join(h.docs, "chapter.md"));
    const initial = h.checkpoints()[0]!;
    const mountEntry = h.manager.getEntries().find((entry) => entry.type === "custom" && (entry.data as { id?: string })?.id === initial.id)!;
    const before = h.manager.getLeafId();
    assert.equal((await h.session.navigateTree(mountEntry.id)).cancelled, true);
    assert.equal(h.manager.getLeafId(), before);
    assert.equal(await readFile(join(h.cwd, "outside.md"), "utf8"), "outside");
    assert.equal(h.requests.length, 2);
  } finally { await h.close(); }
});

test("steering and queued follow-ups extend the current frozen task until the run settles", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond(async () => {
      await h.session.steer("also check tone");
      await h.session.followUp("then summarize");
      return [call("write", "write", { path: "docs/chapter.md", content: "queued update" })];
    }, "tone checked", "summary");
    await h.session.prompt("update");
    assert.equal(h.requests.length, 3);
    assert.equal(new Set(h.requests.map(snapshotText)).size, 1);
    const taskIds = h.checkpoints().filter((checkpoint) => checkpoint.kind === "task-start").map((checkpoint) => checkpoint.task!.id);
    assert.equal(taskIds.length, 1);
    assert.equal(h.checkpoints().at(-1)!.task?.status, "completed");
    h.respond("new task");
    await h.session.prompt("next idle instruction");
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=13\nqueued update');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("aborted tasks retain successful changes and full tool bodies in later requests", async () => {
  const h = await harness({ probe: (pi) => {
    pi.on("tool_execution_end", (event, ctx) => { if (event.toolCallId === "abort-after-write") ctx.abort(); });
  } });
  try {
    await h.mount();
    h.respond([call("abort-after-write", "write", { path: "docs/chapter.md", content: "partial" })]);
    await h.session.prompt("interrupted task");
    assert.equal(await h.text(), "partial");
    assert.equal(h.checkpoints().at(-1)!.task?.status, "incomplete");
    h.respond("continue");
    await h.session.prompt("new task after abort");
    const old = h.requests.at(-1)!.messages.flatMap((message) => message.role === "assistant" ? message.content : [])
      .find((block) => block.type === "toolCall" && block.id === "abort-after-write");
    assert(old?.type === "toolCall");
    assert.equal(old.arguments.content, "partial");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("failed edits leave disk unchanged and cannot become omission candidates", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond([call("bad", "edit", { path: "docs/chapter.md", edits: [{ oldText: "absent", newText: "replacement" }] })], "could not edit");
    await h.session.prompt("bad edit");
    assert.equal(await h.text(), "initial\n");
    h.respond("review");
    await h.session.prompt("review failed edit");
    const old = h.requests.at(-1)!.messages.flatMap((message) => message.role === "assistant" ? message.content : [])
      .find((block) => block.type === "toolCall" && block.id === "bad");
    assert(old?.type === "toolCall");
    assert.deepEqual(old.arguments.edits, [{ oldText: "absent", newText: "replacement" }]);
    assert.equal(h.checkpoints().at(-1)!.omissions.length, 0);
  } finally { await h.close(); }
});
