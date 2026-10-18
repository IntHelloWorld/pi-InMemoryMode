import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { EXTERNAL_CHANGE_TYPE, fileChanges, type FileChange } from "../src/external-changes.ts";
import { Store } from "../src/store.ts";
import { Workspace } from "../src/workspace.ts";
import { call, harness, snapshotText } from "./helpers.ts";

type Harness = Awaited<ReturnType<typeof harness>>;
function externalMessages(h: Harness) {
  return h.manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === EXTERNAL_CHANGE_TYPE);
}

const image = { type: "image" as const, mimeType: "image/png", data:
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };

test("conflict notices list detected file and permission changes; reload and status reuse that result without rescanning", async () => {
  const disk = Workspace.prototype.disk;
  let scans = 0;
  Workspace.prototype.disk = function () { scans++; return disk.call(this); };
  const h = await harness({ files: { "edit.md": "before", "delete.txt": "remove", "mode.md": "same bytes",
    "both.md": "before", "unchanged.md": "unchanged" } });
  try {
    await h.mount();
    const initial = h.checkpoints().at(-1)!;
    await writeFile(join(h.docs, "edit.md"), "outside content must not appear in the notice");
    await writeFile(join(h.docs, "both.md"), "changed content and permissions");
    await rm(join(h.docs, "delete.txt"));
    for (const path of ["mode.md", "both.md"]) {
      const mode = (await stat(join(h.docs, path))).mode & 0o777;
      await chmod(join(h.docs, path), mode ^ 0o100);
    }
    await mkdir(join(h.docs, "nested"));
    const unusualPath = 'nested/带"引号\n换行.txt';
    await writeFile(join(h.docs, unusualPath), "new outside file");
    await h.session.prompt("blocked instruction");
    assert.equal(h.requests.length, 0);
    assert.equal(scans, 1);
    const checkpoint = h.checkpoints().at(-1)!;
    assert(checkpoint.pendingExternal && checkpoint.externalSnapshotId);
    const store = new Store(initial.config);
    const before = await store.loadSnapshot(initial.workingId);
    const detected = await store.loadSnapshot(checkpoint.externalSnapshotId);
    assert.deepEqual(fileChanges(before, detected), [
      { path: "both.md", kind: "modified" }, { path: "delete.txt", kind: "deleted" },
      { path: "edit.md", kind: "modified" }, { path: "mode.md", kind: "modified" }, { path: unusualPath, kind: "added" },
    ]);
    const expectedRows = [
      '  • 修改及权限  "both.md"', '  • 删除  "delete.txt"', '  • 修改  "edit.md"', '  • 权限  "mode.md"',
      `  • 新增  ${JSON.stringify(unusualPath)}`,
    ];
    const assertList = (notice: string) => {
      assert.deepEqual(notice.split("\n").filter((line) => /^  • (新增|修改|删除|权限)/.test(line)), expectedRows);
      assert(!notice.includes("unchanged.md"));
      assert(!notice.includes("outside content must not appear in the notice"));
    };
    assertList(h.notices.at(-1)!);
    await h.session.prompt("/memory status");
    assertList(h.notices.at(-1)!);
    const notices = h.notices.length;
    await h.session.reload();
    assert.equal(h.notices.length, notices);
    await writeFile(join(h.docs, "later.md"), "not scanned yet");
    await h.session.prompt("/memory status");
    assertList(h.notices.at(-1)!);
    assert(!h.notices.at(-1)!.includes("later.md"));
    assert.equal(scans, 1);
    await h.session.prompt("/memory recover");
    assert.equal(await h.text("edit.md"), "before");
    await assert.rejects(h.text(unusualPath), { code: "ENOENT" });
    await assert.rejects(h.text("later.md"), { code: "ENOENT" });
    assert.equal(h.checkpoints().at(-1)!.externalSnapshotId, undefined);
    const afterRecovery = h.notices.length;
    await h.session.prompt("/memory status");
    assert.equal(h.notices.length, afterRecovery + 1);
    assert(!h.notices.at(-1)!.includes("未同步文件"));
    assert.deepEqual(h.errors, []);
  } finally { Workspace.prototype.disk = disk; await h.close(); }
});

test("first-request conflict preserves the submission; sync records versions and refills the editor without starting a task", async () => {
  const h = await harness({ persisted: true, files: { "chapter.md": "original", "remove.txt": "old" } });
  try {
    await h.mount();
    const initial = h.checkpoints().at(-1)!;
    await writeFile(join(h.docs, "chapter.md"), "outside");
    await rm(join(h.docs, "remove.txt"));
    await mkdir(join(h.docs, "nested"));
    await writeFile(join(h.docs, "nested/new.md"), "new file");
    const notices = h.notices.length;
    await setTimeout(1100);
    await h.session.prompt("/memory status");
    assert.equal(h.checkpoints().at(-1)!.id, initial.id);
    assert.equal(h.notices.length, notices + 1);
    const instruction = "请逐条执行这些要求：\n" + "保留每一条详细要求。\n".repeat(100);
    await h.session.prompt(instruction);
    assert.equal(h.requests.length, 0);
    assert.equal(h.checkpoints().filter((cp) => cp.kind === "task-start").length, 0);
    assert.equal(h.checkpoints().at(-1)!.task, undefined);
    const raw = structuredClone(h.manager.getEntries());
    await h.session.prompt("/memory sync");
    assert.equal(h.requests.length, 0);
    assert.equal(h.editorText, instruction);
    assert.deepEqual(h.manager.getEntries().slice(0, raw.length), raw);
    assert(!h.manager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user"));
    const message = externalMessages(h)[0]!;
    assert(message.type === "custom_message");
    const details = message.details as { fromId: string; toId: string; changes: FileChange[] };
    assert.equal(details.fromId, initial.workingId);
    assert.equal(details.toId, h.checkpoints().at(-1)!.workingId);
    assert.deepEqual(details.changes, [
      { path: "chapter.md", kind: "modified" }, { path: "nested/new.md", kind: "added" }, { path: "remove.txt", kind: "deleted" },
    ]);
    const store = new Store(initial.config);
    assert.equal((await store.loadSnapshot(details.fromId)).contents.get("chapter.md")!.toString(), "original");
    assert.equal((await store.loadSnapshot(details.toId)).contents.get("chapter.md")!.toString(), "outside");
    h.respond("reviewed");
    await h.session.prompt(h.editorText);
    assert.equal(h.requests.length, 1);
    assert.equal(snapshotText(h.requests[0]!), 'path="chapter.md" bytes=7\noutside\npath="nested/new.md" bytes=8\nnew file');
    const prompts = h.requests[0]!.messages.filter((message) => message.role === "user" && Array.isArray(message.content) &&
      message.content.some((block) => block.type === "text" && block.text === instruction));
    assert.equal(prompts.length, 1);
    assert.equal(externalMessages(h).length, 1);
    const unchanged = structuredClone(h.manager.getEntries());
    await h.session.prompt("/memory sync");
    assert.deepEqual(h.manager.getEntries(), unchanged);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("recover before the first request preserves the previous completed task and restores text and attachments", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond("previous report");
    await h.session.prompt("previous task");
    const completed = h.checkpoints().at(-1)!;
    const instruction = "尚未执行的长指令\n".repeat(40);
    await writeFile(join(h.docs, "chapter.md"), "outside");
    await h.session.prompt(instruction, { images: [image] });
    assert.equal(h.requests.length, 1);
    assert.equal(h.checkpoints().at(-1)!.task?.id, completed.task!.id);
    assert.equal(h.checkpoints().at(-1)!.task?.status, "completed");
    await h.session.prompt("/memory recover");
    assert.equal(await h.text(), "initial\n");
    assert.equal(h.requests.length, 1);
    assert.equal(h.editorText, instruction);
    h.respond("new report");
    await h.session.prompt(h.editorText);
    const request = h.requests.at(-1)!;
    const prompt = request.messages.findLast((message) => message.role === "user");
    assert(prompt && Array.isArray(prompt.content));
    assert(prompt.content.some((block) => block.type === "image"), JSON.stringify(prompt.content));
    assert.notEqual(h.checkpoints().at(-1)!.task?.id, completed.task?.id);
    assert.equal(externalMessages(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("write interruption preserves queued instructions and sync ends the incomplete task without replaying them", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond(async () => {
      await h.session.followUp("queued requirement one");
      await h.session.followUp("queued requirement two", [image]);
      await writeFile(join(h.docs, "chapter.md"), "outside");
      return [call("blocked", "write", { path: "docs/chapter.md", content: "must not overwrite" })];
    });
    await h.session.prompt("original task");
    assert.equal(h.requests.length, 1);
    const interrupted = h.checkpoints().at(-1)!;
    assert.equal(interrupted.task?.status, "incomplete");
    assert.equal(interrupted.pendingExternal, true);
    await h.session.prompt("/memory sync");
    assert.equal(h.requests.length, 1);
    assert.equal(h.editorText, "queued requirement one\n\nqueued requirement two");
    assert.equal(h.checkpoints().find((cp) => cp.id === interrupted.id)!.task?.status, "incomplete");
    h.respond("new task reply");
    await h.session.prompt(h.editorText);
    assert.equal(h.requests.length, 2);
    assert.notEqual(h.checkpoints().at(-1)!.task?.id, interrupted.task?.id);
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=7\noutside');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("recover after interruption restores the latest successful writes, keeps the task history, and leaves rollback to tree", async () => {
  const h = await harness({ persisted: true, probe: (pi) => {
    pi.on("tool_execution_end", async (event, ctx) => {
      if (event.toolCallId === "progress") {
        await writeFile(join(ctx.cwd, "docs/chapter.md"), "outside");
        await writeFile(join(ctx.cwd, "docs/outside.md"), "outside addition");
      }
    });
  } });
  try {
    await h.mount();
    h.respond("before task report");
    await h.session.prompt("remember original");
    const before = h.report();
    h.respond([call("progress", "write", { path: "docs/chapter.md", content: "task progress" })], "unfinished report");
    await h.session.prompt("task interrupted after successful write");
    const interrupted = h.checkpoints().at(-1)!;
    assert.notEqual(interrupted.workingId, interrupted.baselineId);
    const raw = structuredClone(h.manager.getEntries());
    await h.session.prompt("/memory recover");
    assert.equal(h.requests.length, 3);
    assert.equal(await h.text(), "task progress");
    await assert.rejects(h.text("outside.md"), { code: "ENOENT" });
    assert.equal(h.checkpoints().at(-1)!.workingId, interrupted.workingId);
    assert.deepEqual(h.manager.getEntries().slice(0, raw.length), raw);
    assert(h.manager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant" &&
      entry.message.content.some((block) => block.type === "toolCall" && block.id === "progress")));
    h.respond("new task completed");
    await h.session.prompt("continue the remaining work as a new task");
    assert.notEqual(h.checkpoints().at(-1)!.task?.id, interrupted.task?.id);
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=13\ntask progress');
    const original = h.requests.at(-1)!.messages.flatMap((message) => message.role === "assistant" ? message.content : [])
      .find((block) => block.type === "toolCall" && block.id === "progress");
    assert(original?.type === "toolCall");
    assert.equal(original.arguments.content, "task progress");
    await h.session.navigateTree(before.id);
    assert.equal(await h.text(), "initial\n");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("sync preserves complete interrupted tool pairs and records the changed version", async () => {
  const h = await harness({ probe: (pi) => {
    pi.on("tool_execution_end", async (event, ctx) => {
      if (event.toolCallId === "managed") await writeFile(join(ctx.cwd, "docs/chapter.md"), "external after tool");
    });
  } });
  try {
    await h.mount();
    h.respond([call("managed", "write", { path: "docs/chapter.md", content: "managed write" })], "unfinished report");
    await h.session.prompt("edit before outside change");
    await h.session.prompt("/memory sync");
    const message = externalMessages(h)[0]!;
    const raw = h.manager.getBranch();
    const result = raw.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "managed");
    assert(result >= 0 && raw.findIndex((entry) => entry.id === message.id) > result);
    h.respond("new report");
    await h.session.prompt("new task");
    const original = h.requests.at(-1)!.messages.flatMap((entry) => entry.role === "assistant" ? entry.content : [])
      .find((block) => block.type === "toolCall" && block.id === "managed");
    assert(original?.type === "toolCall");
    assert.equal(original.arguments.content, "managed write");
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=19\nexternal after tool');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("settlement detects an external save after the final report before marking the task complete", async () => {
  const h = await harness({ probe: (pi) => {
    pi.on("turn_end", async (_event, ctx) => { await writeFile(join(ctx.cwd, "docs/chapter.md"), "after final report"); });
  } });
  try {
    await h.mount();
    h.respond("final report");
    await h.session.prompt("task");
    assert.equal(h.requests.length, 1);
    assert.equal(h.checkpoints().at(-1)!.task?.status, "incomplete");
    assert.equal(h.checkpoints().at(-1)!.pendingExternal, true);
    await h.session.prompt("/memory recover");
    assert.equal(await h.text(), "initial\n");
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("write-commit check stops an external overwrite while read-only continuations defer comparison to settlement", async () => {
  for (const tool of ["write", "read"] as const) {
    const h = await harness();
    try {
      await h.mount();
      h.respond(async () => {
        await writeFile(join(h.docs, "chapter.md"), "outside");
        return [call("operation", tool, tool === "write" ? { path: "docs/chapter.md", content: "must not overwrite" } : { path: "docs/chapter.md" })];
      }, "report based on frozen memory");
      await h.session.prompt("task");
      assert.equal(h.requests.length, tool === "write" ? 1 : 2);
      assert.equal(await h.text(), "outside");
      assert.equal(h.checkpoints().at(-1)!.task?.status, "incomplete");
      const result = h.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult");
      assert(result?.type === "message" && result.message.role === "toolResult");
      assert.equal(result.message.isError, tool === "write");
      if (tool === "read") {
        assert.deepEqual(result.message.content, [{ type: "text", text: "initial\n" }]);
        assert.equal(snapshotText(h.requests[1]!), snapshotText(h.requests[0]!));
      }
      await h.session.prompt("/memory recover");
      assert.equal(await h.text(), "initial\n");
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  }
});

test("automatic comparisons happen once per task start, before commits, and at final settlement", async () => {
  const original = Workspace.prototype.consistent;
  let comparisons = 0;
  Workspace.prototype.consistent = function () { comparisons++; return original.call(this); };
  const h = await harness();
  try {
    await h.mount();
    h.respond(async () => {
      await h.session.steer("also review the chapter");
      await h.session.followUp("provide a final summary");
      return [call("read", "read", { path: "docs/chapter.md" })];
    }, [call("write", "write", { path: "docs/chapter.md", content: "managed" })], "report", "final summary");
    await h.session.prompt("edit");
    assert.equal(h.requests.length, 4);
    assert.equal(comparisons, 3); // One task start, one commit and one final settlement.
    assert.equal(h.checkpoints().filter((cp) => cp.kind === "task-start").length, 1);
    assert.equal(h.checkpoints().at(-1)!.task?.status, "completed");
    const taskId = h.checkpoints().at(-1)!.task!.id;
    h.respond([call("review", "read", { path: "docs/chapter.md" })], "reviewed");
    await h.session.prompt("review without modifying files");
    assert.equal(h.requests.length, 6);
    assert.equal(comparisons, 5); // A new read-only task adds only its start and final checks.
    assert.notEqual(h.checkpoints().at(-1)!.task!.id, taskId);
    await h.session.prompt("/memory status");
    await h.session.extensionRunner.emit({ type: "session_before_switch", reason: "resume", targetSessionFile: "/other.jsonl" });
    await h.session.reload();
    assert.equal(comparisons, 5);
    const mount = h.manager.getEntries().find((entry) => entry.type === "custom" && (entry.data as { kind?: string })?.kind === "mount")!;
    await h.session.navigateTree(mount.id);
    assert.equal(comparisons, 6); // Tree restoration also commits managed disk changes.
    assert.deepEqual(h.errors, []);
  } finally { Workspace.prototype.consistent = original; await h.close(); }
});

test("pending decisions block compaction; retired commands and parameter forms have no side effects", async () => {
  const h = await harness({ keepRecentTokens: 1 });
  try {
    await h.mount();
    h.respond("first report", "second report");
    await h.session.prompt("first task");
    await h.session.prompt("second task");
    await writeFile(join(h.docs, "chapter.md"), "pending");
    await h.session.prompt("pending instruction");
    const before = structuredClone(h.manager.getEntries());
    await assert.rejects(h.session.compact(), /cancelled/i);
    for (const command of ["/memory save-change", "/memory continue", "/memory recover --from-disk", "/memory sync --force"]) {
      await h.session.prompt(command);
      assert.equal(await h.text(), "pending");
      assert.deepEqual(h.manager.getEntries(), before);
    }
    await h.session.prompt("/memory recover");
    assert.equal(await h.text(), "initial\n");
    assert.equal(h.editorText, "pending instruction");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("atomic saves and permission changes are detected at the next task start; excluded paths do not interrupt", async () => {
  const h = await harness();
  try {
    await h.mount();
    await writeFile(join(h.docs, "ignored.png"), Buffer.from([1, 2]));
    await mkdir(join(h.docs, ".hidden"));
    await writeFile(join(h.docs, ".hidden/secret.md"), "ignored");
    h.respond("ignored excluded files");
    await h.session.prompt("first task");
    assert.equal(h.requests.length, 1);
    const temporary = join(h.docs, ".editor-save.tmp");
    await writeFile(temporary, "atomic save");
    await rename(temporary, join(h.docs, "chapter.md"));
    await h.session.prompt("blocked after atomic save");
    assert.equal(h.requests.length, 1);
    await h.session.prompt("/memory sync");
    const mode = (await stat(join(h.docs, "chapter.md"))).mode & 0o777;
    await chmod(join(h.docs, "chapter.md"), mode === 0o600 ? 0o640 : 0o600);
    await h.session.prompt(h.editorText);
    assert.equal(h.requests.length, 1);
    await h.session.prompt("/memory sync");
    assert.equal(externalMessages(h).length, 2);
    h.respond("reviewed");
    await h.session.prompt(h.editorText);
    assert.equal(snapshotText(h.requests.at(-1)!), 'path="chapter.md" bytes=11\natomic save');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("recover backs up discarded external files and leaves successful checkpoint content intact", async () => {
  const h = await harness();
  try {
    await h.mount();
    h.respond([call("saved", "write", { path: "docs/chapter.md", content: "saved version" })], "saved");
    await h.session.prompt("save");
    const cp = h.checkpoints().at(-1)!;
    await writeFile(join(h.docs, "chapter.md"), "discarded outside edit");
    await writeFile(join(h.docs, "extra.md"), "outside extra");
    await h.session.prompt("/memory recover");
    assert.equal(await h.text(), "saved version");
    await assert.rejects(h.text("extra.md"), { code: "ENOENT" });
    const store = new Store(cp.config);
    const directory = join(store.directory, "transactions");
    const transactions = await Promise.all((await readdir(directory)).map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8"))));
    const tx = transactions.find((item) => item.kind === "recovery" && item.toId === cp.workingId);
    const backup = await store.loadSnapshot(tx.fromId);
    assert.equal(backup.contents.get("chapter.md")!.toString(), "discarded outside edit");
    assert.equal(backup.contents.get("extra.md")!.toString(), "outside extra");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

for (const started of [false, true]) {
  test(`reopening a ${started ? "started" : "not-yet-started"} blocked task preserves its files and drafts until explicit recovery`, async () => {
    const first = await harness({ persisted: true, probe: (pi) => {
      pi.on("tool_execution_end", async (event, ctx) => {
        if (event.toolCallId === "progress") await writeFile(join(ctx.cwd, "docs/chapter.md"), "outside");
      });
    } });
    let second: Harness | undefined;
    try {
      await first.mount();
      if (started) first.respond([call("progress", "write", { path: "docs/chapter.md", content: "saved progress" })], "unfinished report");
      else await writeFile(join(first.docs, "chapter.md"), "outside");
      await first.session.prompt("original instruction");
      const file = first.manager.getSessionFile()!;
      await first.close(false);
      second = await harness({ files: {}, existing: { cwd: first.cwd, manager: SessionManager.open(file) } });
      assert.equal(await second.text(), "outside");
      await second.session.prompt("/memory recover");
      assert.equal(await second.text(), started ? "saved progress" : "initial\n");
      assert.equal(second.requests.length, 0);
      if (!started) assert.equal(second.editorText, "original instruction");
      second.respond("new report");
      await second.session.prompt(started ? "new task" : second.editorText);
      assert.equal(second.requests.length, 1);
      assert.deepEqual(second.errors, []);
    } finally { if (second) await second.close(); else await first.close(); }
  });
}
