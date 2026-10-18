import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Model } from "@earendil-works/pi-ai";
import { call, harness, type Reply } from "./helpers.ts";

function response(reply: Reply, cached = 0): Response {
  const events: Array<{ type: string; [key: string]: unknown }> = [{ type: "message_start", message: {
    id: "local-message", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0,
      cache_read_input_tokens: cached, cache_creation_input_tokens: 0 },
  } }];
  if (typeof reply === "string") {
    events.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } },
      { type: "content_block_stop", index: 0 });
  } else {
    reply.forEach((tool, index) => {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } },
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.arguments) } },
        { type: "content_block_stop", index });
    });
  }
  events.push({ type: "message_delta", delta: { stop_reason: typeof reply === "string" ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" });
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

interface Payload {
  system: unknown;
  tools: unknown[];
  messages: Array<{ role: string; content: Array<{ type: string; text?: string; id?: string; input?: Record<string, unknown>;
    tool_use_id?: string; is_error?: boolean; content?: unknown; cache_control?: unknown }> }>;
}

test("official Anthropic serializer keeps task prefix stable and accepts paired projected calls", async () => {
  const h = await harness();
  const payloads: Payload[] = [];
  const replies: Reply[] = [[call("w1", "write", { path: "docs/chapter.md", content: "updated" })], "done", "reviewed"];
  h.session.agent.streamFunction = (model, context, options) => anthropicStream(model as Model<"anthropic-messages">, context, {
    ...options, apiKey: "local-test-key", cacheRetention: "short",
    fetch: async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return response(replies.shift()!, payloads.length === 2 ? 64 : 0);
    },
  });
  try {
    await h.mount();
    await h.session.prompt("update");
    assert.equal(await h.text(), "updated");
    await h.session.prompt("review");
    assert.equal(payloads.length, 3);
    assert.deepEqual(payloads[0]!.system, payloads[1]!.system);
    assert.deepEqual(payloads[0]!.tools, payloads[1]!.tools);
    assert.deepEqual(payloads[0]!.messages, payloads[1]!.messages.slice(0, payloads[0]!.messages.length));
    const firstBaseline = payloads[0]!.messages.flatMap((message) => message.content).find((block) => block.text?.startsWith("path="));
    const nextBaseline = payloads[2]!.messages.flatMap((message) => message.content).find((block) => block.text?.startsWith("path="));
    assert.equal(firstBaseline?.text, 'path="chapter.md" bytes=8\ninitial\n');
    assert.equal(nextBaseline?.text, 'path="chapter.md" bytes=7\nupdated');
    const oldCall = payloads[2]!.messages.flatMap((message) => message.content).find((block) => block.type === "tool_use" && block.id === "w1");
    assert.deepEqual(oldCall?.input, { path: "docs/chapter.md", content: "[历史正文已省略]" });
    const result = payloads[2]!.messages.flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.tool_use_id === oldCall?.id);
    assert(result);
    assert.equal(result.is_error, false);
    assert.equal(result.content, "已成功。");
    assert(payloads[0]!.messages.some((message) => message.content.some((block) => block.cache_control)));
    const usageRecords = h.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "inmemory.usage");
    assert(usageRecords.some((entry) => entry.type === "custom" && (entry.data as { cacheRead: number }).cacheRead === 64));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("official provider never reaches fetch after capacity abort in context transform", async () => {
  const h = await harness({ contextWindow: 1800 });
  let fetches = 0;
  h.session.agent.streamFunction = (model, context, options) => anthropicStream(model as Model<"anthropic-messages">, context, {
    ...options, apiKey: "local-test-key", fetch: async () => { fetches++; return response("should not happen"); },
  });
  try {
    await h.mount();
    await h.session.prompt("edit");
    assert.equal(fetches, 0);
    assert.equal(await h.text(), "initial\n");
  } finally { await h.close(); }
});

test("official serializer preserves interrupted tool pairs after recover and a new task uses the saved progress", async () => {
  const h = await harness({ probe: (pi) => {
    pi.on("tool_execution_end", async (event, ctx) => {
      if (event.toolCallId === "progress") await writeFile(join(ctx.cwd, "docs/chapter.md"), "outside");
    });
  } });
  const payloads: Payload[] = [];
  const replies: Reply[] = [[call("progress", "write", { path: "docs/chapter.md", content: "progress" }),
    call("pending-read", "read", { path: "docs/chapter.md" })], "unfinished report", "continued report"];
  h.session.agent.streamFunction = (model, context, options) => anthropicStream(model as Model<"anthropic-messages">, context, {
    ...options, apiKey: "local-test-key",
    fetch: async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return response(replies.shift()!);
    },
  });
  try {
    await h.mount();
    await h.session.prompt("original task");
    assert.equal(payloads.length, 2);
    const task = h.checkpoints().at(-1)!.task!;
    assert.equal(task.status, "incomplete");
    await h.session.prompt("/memory recover");
    assert.equal(payloads.length, 2);
    await h.session.prompt("continue the remaining work in a new task");
    assert.equal(await h.text(), "progress");
    assert.equal(payloads.length, 3);
    const blocks = payloads[2]!.messages.flatMap((message) => message.content);
    const calls = blocks.filter((block) => block.type === "tool_use");
    const results = blocks.filter((block) => block.type === "tool_result");
    assert.deepEqual(calls.map((block) => block.id).sort(), ["pending-read", "progress"]);
    assert.deepEqual(results.map((block) => block.tool_use_id).sort(), ["pending-read", "progress"]);
    assert.equal(calls.find((block) => block.id === "progress")?.input?.content, "progress");
    assert.equal(blocks.find((block) => block.text?.startsWith("path="))?.text, 'path="chapter.md" bytes=8\nprogress');
    assert.notEqual(h.checkpoints().at(-1)!.task?.id, task.id);
    assert.equal(h.checkpoints().at(-1)!.task?.status, "completed");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
