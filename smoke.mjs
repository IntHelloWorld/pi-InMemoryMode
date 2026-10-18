import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));
const agentDir = await mkdtemp(join(tmpdir(), "pi-plugin-smoke-"));
const workingDir = join(agentDir, "project");
await mkdir(workingDir);
const documents = join(agentDir, "documents");
await mkdir(documents);
await writeFile(join(documents, "sample.md"), "# Smoke document\n");
const child = spawn(process.execPath, [
  process.argv[2] ?? join(projectRoot, "node_modules/.bin/pi"),
  "--mode", "rpc",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-tools",
  "-e", projectRoot,
], {
  cwd: workingDir,
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_NO_LOCAL_LLM: "1",
    AWS_EC2_METADATA_DISABLED: "true",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const exited = once(child, "exit");
const pending = new Map();
const notifications = [];
let stderr = "";
let sequence = 0;
child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "extension_ui_request") notifications.push(message);
  if (message.type === "response") pending.get(message.id)?.(message);
});

async function request(type, fields = {}) {
  const id = `smoke-${++sequence}`;
  let timeout;
  try {
    const response = await Promise.race([
      new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      }),
      exited.then(([code, signal]) => {
        throw new Error(`Pi exited early (${code ?? signal}). ${stderr}`);
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}. ${stderr}`)), 30000);
      }),
    ]);
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  } finally {
    clearTimeout(timeout);
    pending.delete(id);
  }
}

try {
  const { commands } = await request("get_commands");
  assert(commands.some((command) => command.name === "plugin-dev" && command.source === "extension"),
    "Pi did not load the extension declared by package.json");
  const result = await request("prompt", { message: "/plugin-dev" });
  assert.equal(result.disposition, "handled");
  assert(notifications.some((message) => message.method === "notify"
    && message.message === "pi-inmemory-mode: development environment ready"));
  assert(commands.some((command) => command.name === "memory"));
  await request("prompt", { message: `/memory on ${documents}` });
  await request("prompt", { message: "/memory status" });
  assert(notifications.some((message) => message.method === "notify" && message.message.includes("In Memory：ready")));
  const beforeOff = notifications.length;
  await request("prompt", { message: "/memory off" });
  assert(notifications.slice(beforeOff).some((message) => message.method === "notify" && message.notifyType === "error"));
  const afterOff = notifications.length;
  await request("prompt", { message: "/memory status" });
  assert(notifications.slice(afterOff).some((message) => message.method === "notify" && message.message.includes("In Memory：ready")));
  const beforeExternal = notifications.length;
  await writeFile(join(documents, "sample.md"), "accepted external content");
  await delay(150);
  assert.equal(notifications.length, beforeExternal, "Idle file changes must wait for a boundary check");
  await request("prompt", { message: "/memory status" });
  assert(!notifications.slice(beforeExternal).some((message) => message.method === "notify" && message.message.includes("/memory sync")),
    "Read-only status must not scan external files");
  assert.equal((await request("get_messages")).messages.filter((message) => message.customType === "inmemory.external-change").length, 0);
  await request("prompt", { message: "/memory sync" });
  const accepted = (await request("get_messages")).messages.filter((message) => message.customType === "inmemory.external-change");
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].details.changes, [{ path: "sample.md", kind: "modified" }]);
  await writeFile(join(documents, "sample.md"), "discarded external content");
  await request("prompt", { message: "/memory recover" });
  assert.equal(await readFile(join(documents, "sample.md"), "utf8"), "accepted external content");
  assert.equal((await request("get_messages")).messages.filter((message) => message.customType === "inmemory.external-change").length, 1);
  const replacement = await request("new_session");
  assert.equal(replacement.cancelled, false);
  await request("prompt", { message: "/memory status" });
  assert(notifications.some((message) => message.method === "notify" && message.message === "会话类型：普通"));
  const left = notifications.length;
  await writeFile(join(documents, "sample.md"), "new session initial content");
  await delay(150);
  assert(!notifications.slice(left).some((message) => message.method === "notify" && message.message.includes("/memory sync")),
    "Departed InMemory session reported changes in its old directory");
  // A new session can acquire the directory after the old session releases ownership.
  await request("prompt", { message: `/memory on ${documents}` });
  const state = await request("get_state");
  assert.equal(state.isStreaming, false);
  assert.equal(state.sessionFile, undefined);
  console.log("PASS: fixed categories, read-only status, explicit sync history, recover and writer-lock transfer; no model call.");
} finally {
  child.kill("SIGTERM");
  await exited;
  lines.close();
  await rm(agentDir, { recursive: true, force: true });
}
