import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Controller } from "./src/controller.ts";
import { errorText } from "./src/types.ts";
import { registerFileTools } from "./src/tools.ts";
import { SessionList } from "./src/session-list.ts";

export default function plugin(pi: ExtensionAPI): void {
  const controller = new Controller(pi);
  const sessions = new SessionList();
  pi.on("session_list", (event, ctx) => sessions.decorate(event, ctx));
  registerFileTools(pi, controller);
  pi.registerCommand("memory", {
    description: "管理 InMemory：on [目录] / status / sync / recover",
    getArgumentCompletions: (prefix) => ["on", "status", "sync", "recover"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      try { await controller.command(args, ctx); }
      catch (error) { ctx.ui.notify(`In Memory：${errorText(error)}`, "error"); }
    },
  });
  pi.registerCommand("plugin-dev", {
    description: "Check that the local plugin is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("pi-inmemory-mode: development environment ready", "info");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    try { await controller.initialize(ctx); }
    catch (error) { controller.stop(error, ctx); }
  });
  pi.on("session_shutdown", async () => { await controller.close(); });
  pi.on("input", (event, ctx) => controller.input(event, ctx));
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      if (event.messageType === "user") controller.prepare(event);
      else if (controller.enabled) throw new Error("InMemory 请通过用户指令启动新任务。");
    } catch (error) { controller.stop(error, ctx); }
  });
  pi.on("context_with_system", async (event, ctx) => {
    try { return { messages: await controller.context(event.messages, ctx) }; }
    catch (error) {
      // Pi catches handler exceptions. Explicit abort is necessary to cancel the request.
      controller.stop(error, ctx);
      return { messages: event.messages };
    }
  });
  pi.on("before_provider_request", (event, ctx) => controller.observeRequest(event.payload, ctx));
  pi.on("message_end", (event) => { controller.observeUsage(event.message); });
  pi.on("tool_call", async (_event, ctx) => {
    if (!controller.enabled) return;
    try { controller.workspace!.assertReady(); }
    catch (error) {
      controller.stop(error, ctx);
      return { block: true, terminate: true, reason: errorText(error) };
    }
  });
  pi.on("turn_end", async (event, ctx) => {
    try { return await controller.turn(ctx, event.outcome, event.toolResultEntryIds.at(-1) ?? event.messageEntryId); }
    catch (error) { controller.stop(error, ctx); }
  });
  pi.on("agent_settled", async (event, ctx) => {
    try { await controller.settle(ctx, event.aborted); }
    catch (error) { controller.stop(error, ctx); }
  });
  pi.on("session_before_tree", async (event, ctx) => {
    try { await controller.beforeTree(ctx, event.preparation.targetId, event.preparation.userWantsSummary); }
    catch (error) {
      ctx.ui.notify(`已取消树切换：${errorText(error)}`, "error");
      return { cancel: true };
    }
  });
  pi.on("session_tree_open", async (event, ctx) => {
    try { await controller.openTree(event, ctx); }
    catch (error) {
      event.cancel = true;
      ctx.ui.notify(`无法打开恢复位置：${errorText(error)}`, "error");
    }
  });
  pi.on("session_tree", async (event, ctx) => {
    try { await controller.afterTree(ctx, event.newLeafId); }
    catch (error) { controller.stop(error, ctx); }
  });
  pi.on("session_before_fork", (_event, ctx) => {
    if (controller.enabled) {
      ctx.ui.notify("InMemory 会话使用 /tree 管理文件分支；如需普通会话，请使用 /new 或 /resume。", "warning");
      return { cancel: true };
    }
  });
  pi.on("session_before_switch", async (_event, ctx) => {
    try { await controller.beforeSwitch(ctx); }
    catch (error) {
      controller.stop(error, ctx);
      return { cancel: true };
    }
  });
  pi.on("session_before_compact", async (event, ctx) => {
    if (controller.enabled && controller.workspace?.mode !== "ready") return { cancel: true };
    if (controller.enabled && (controller.task?.status === "running" || controller.task?.interruption || event.willRetry)) {
      ctx.ui.notify("请结束当前 In Memory 任务后再压缩历史，以保留冻结基线后的完整修改记录。", "warning");
      return { cancel: true };
    }
  });
  pi.on("session_compact", async (event, ctx) => {
    try { await controller.compact(ctx, event.compactionEntry.id); }
    catch (error) { controller.stop(error, ctx); }
  });
}
