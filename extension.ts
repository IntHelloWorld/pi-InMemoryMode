import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Controller } from "./src/controller.ts";
import { errorText } from "./src/types.ts";
import { registerFileTools } from "./src/tools.ts";
import { SessionList } from "./src/session-list.ts";
import { IdeBridge } from "./src/ide-bridge.ts";

export default function plugin(pi: ExtensionAPI): void {
  const controller = new Controller(pi);
  const ide = new IdeBridge(pi, controller);
  const sessions = new SessionList();
  pi.on("session_list", (event, ctx) => sessions.decorate(event, ctx));
  registerFileTools(pi, controller);
  pi.registerCommand("inmem", {
    description: "Manage InMemory: on [directory] / status / check / sync / recover",
    getArgumentCompletions: (prefix) => ["on", "status", "check", "sync", "recover"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        if (args.trim() === "check") await controller.checkExternal(ctx);
        else await controller.command(args, ctx);
      }
      catch (error) { ctx.ui.notify(`InMemory: ${errorText(error)}`, "error"); }
      finally { ide.update(ctx); }
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
    try { await ide.start(ctx); }
    catch (error) { ctx.ui.notify(`IDE bridge could not start: ${errorText(error)}`, "warning"); }
  });
  pi.on("session_shutdown", async () => { await ide.close(); await controller.close(); });
  // Context getters follow the active Pi session; no background file scan is added.
  pi.on("agent_start", (_event, ctx) => ide.update(ctx));
  pi.on("agent_settled", (_event, ctx) => ide.update(ctx));
  pi.on("input", (event, ctx) => controller.input(event, ctx));
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      if (event.messageType === "user") controller.prepare(event);
      else if (controller.enabled) throw new Error("Start a new InMemory task with a user instruction.");
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
      ctx.ui.notify(`Tree navigation cancelled: ${errorText(error)}`, "error");
      return { cancel: true };
    }
  });
  pi.on("session_tree_open", async (event, ctx) => {
    try { await controller.openTree(event, ctx); }
    catch (error) {
      event.cancel = true;
      ctx.ui.notify(`Cannot open recovery point: ${errorText(error)}`, "error");
    }
  });
  pi.on("session_tree", async (event, ctx) => {
    try { await controller.afterTree(ctx, event.newLeafId); }
    catch (error) { controller.stop(error, ctx); }
  });
  pi.on("session_before_fork", (_event, ctx) => {
    if (controller.enabled) {
      ctx.ui.notify("Use /tree to manage file branches in an InMemory session. Use /new or /resume for an ordinary session.", "warning");
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
      ctx.ui.notify("Finish the current InMemory task before compacting history so the complete edit history after the frozen baseline is preserved.", "warning");
      return { cancel: true };
    }
  });
  pi.on("session_compact", async (event, ctx) => {
    try { await controller.compact(ctx, event.compactionEntry.id); }
    catch (error) { controller.stop(error, ctx); }
  });
}
