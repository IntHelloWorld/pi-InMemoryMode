import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type JsonObject, type ToolCall } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionUIContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import plugin from "../extension.ts";
import { checkpointEntry } from "../src/projection.ts";

export type Reply = string | ToolCall[];

export async function harness(options: { persisted?: boolean; files?: Record<string, string | Buffer>; contextWindow?: number;
  probe?: (pi: ExtensionAPI) => void; keepRecentTokens?: number; existing?: { cwd: string; manager: SessionManager } } = {}) {
  const cwd = options.existing?.cwd ?? await realpath(await mkdtemp(join(tmpdir(), "pi-inmemory-test-")));
  const agentDir = join(cwd, "agent-config");
  const docs = join(cwd, "docs");
  await mkdir(docs, { recursive: true });
  for (const [path, content] of Object.entries(options.files ?? { "chapter.md": "initial\n" })) {
    await mkdir(join(docs, path, ".."), { recursive: true });
    await writeFile(join(docs, path), content);
  }
  const errors: string[] = [];
  const notices: string[] = [];
  const requests: Context[] = [];
  let editorText = "";
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: options.keepRecentTokens ?? 20000 }, retry: { enabled: false }, cacheWarming: "off",
  });
  const model = { ...getModel("anthropic", "claude-sonnet-4-5"), contextWindow: options.contextWindow ?? 200000 };
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  await runtime.setRuntimeApiKey("anthropic", "local-test-no-real-key");
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [plugin, ...(options.probe ? [options.probe] : [])], systemPrompt: "Test assistant." });
  await resourceLoader.reload();
  const manager = options.existing?.manager ?? (options.persisted ? SessionManager.create(cwd, join(cwd, "sessions")) : SessionManager.inMemory(cwd));
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model,
    sessionManager: manager, resourceLoader, settingsManager });
  await session.bindExtensions({ onError: (error) => errors.push(`${error.event}: ${error.error}`), commandContextActions: {
    waitForIdle: () => session.waitForIdle(),
    newSession: async () => { throw new Error("Use a new harness to create a session"); },
    fork: async () => { throw new Error("Fork is not supported by this harness"); },
    navigateTree: (targetId, options) => session.navigateTree(targetId, options),
    switchSession: async () => { throw new Error("Use a new harness to switch sessions"); },
    reload: () => session.reload(),
  }, uiContext: {
    notify: (text: string) => notices.push(text), setStatus: () => {},
    setEditorText: (text: string) => { editorText = text; }, getEditorText: () => editorText,
  } as unknown as ExtensionUIContext });
  let replies: Array<Reply | ((context: Context) => Reply | Promise<Reply>)> = [];
  let abortedRequests = 0;
  session.agent.streamFunction = async (requestModel, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: "assistant", content: [], api: requestModel.api, provider: requestModel.provider,
      model: requestModel.id, stopReason: "stop", timestamp: Date.now(), usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      } };
    if (streamOptions?.signal?.aborted) {
      abortedRequests++;
      message.stopReason = "aborted";
      stream.push({ type: "error", reason: "aborted", error: message });
      stream.end(message);
      return stream;
    }
    requests.push(structuredClone(context));
    const next = replies.shift();
    const reply = typeof next === "function" ? await next(context) : next;
    if (reply === undefined) throw new Error("Unexpected model request in test");
    message.content = typeof reply === "string" ? [{ type: "text", text: reply }] : reply;
    message.stopReason = typeof reply === "string" ? "stop" : "toolUse";
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end(message);
    return stream;
  };
  return { cwd, docs, session, manager, errors, notices, requests, runtime, model,
    get editorText() { return editorText; },
    get abortedRequests() { return abortedRequests; },
    respond(...next: typeof replies) { replies.push(...next); },
    async mount() { await session.prompt("/inmem on docs"); },
    async text(path = "chapter.md") { return readFile(join(docs, path), "utf8"); },
    checkpoints() { return manager.getEntries().filter(checkpointEntry).map((entry) => entry.data!); },
    report(): SessionEntry {
      return manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant")!;
    },
    async close(remove = true) {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      if (remove) await rm(cwd, { recursive: true, force: true });
    },
  };
}

export function call(id: string, name: string, args: JsonObject): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

export function snapshotText(context: Context): string {
  return context.messages.flatMap((message) => message.role === "user" && Array.isArray(message.content)
    ? message.content.filter((block) => block.type === "text" && block.text.startsWith("path=")).map((block) => block.type === "text" ? block.text : "") : []).join("\n");
}
