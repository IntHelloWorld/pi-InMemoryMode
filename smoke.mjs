import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));
const agentDir = await mkdtemp(join(tmpdir(), "pi-plugin-smoke-"));
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
  cwd: projectRoot,
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
  const state = await request("get_state");
  assert.equal(state.isStreaming, false);
  assert.equal(state.sessionFile, undefined);
  console.log("PASS: package discovery, extension command, notification, and in-memory development session; no model call.");
} finally {
  child.kill("SIGTERM");
  await exited;
  lines.close();
  await rm(agentDir, { recursive: true, force: true });
}
