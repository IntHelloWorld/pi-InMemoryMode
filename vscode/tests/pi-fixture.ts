/** A real Pi session with simulated model replies, isolated from personal Pi settings. */
import { join } from "node:path";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { call, harness } from "../../tests/helpers.ts";

const cwd = process.env.PI_IDE_TEST_WORKSPACE!;
const h = await harness({ persisted: true, existing: { cwd, manager: SessionManager.create(cwd, join(cwd, "sessions")) },
  files: { "chapter.md": "initial\n", "delete.md": "deleted later\n" } });
await h.mount();
h.respond((context) => {
  const input = context.messages.findLast((message) => message.role === "user");
  assert(input && Array.isArray(input.content));
  const text = input.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("\n");
  assert.equal(text, 'Selection from VS Code\nFile: "docs/chapter.md"\nLines: 1–1\n```\ninitial\n```');
  return [call("selected-write", "write", { path: "docs/chapter.md", content: "from VS Code\n" })];
}, "saved by test model");
process.stdout.write("IDE_FIXTURE_READY\n");
process.stdin.resume();
process.stdin.once("data", async () => { await h.close(false); process.exit(0); });
