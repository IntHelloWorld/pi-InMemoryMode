import { Type } from "typebox";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { Controller } from "./controller.ts";
import { resolvePath } from "./files.ts";

export function registerFileTools(pi: ExtensionAPI, controller: Controller): void {
  const cwd = process.cwd();
  const read = createReadToolDefinition(cwd);
  const edit = createEditToolDefinition(cwd);
  const write = createWriteToolDefinition(cwd);
  async function managed<T>(ctx: ExtensionToolContext, operation: () => Promise<T>): Promise<T> {
    const workspace = controller.workspace!;
    try {
      return await workspace.queue.run(async () => { workspace.assertReady(); return operation(); });
    } catch (error) {
      if (workspace.mode !== "ready") controller.stop(error, ctx);
      throw error;
    }
  }
  function routed(path: string, ctx: ExtensionToolContext): { absolute: string; relative: string } | undefined {
    if (!controller.enabled) return undefined;
    const absolute = resolvePath(ctx.cwd, path);
    const relative = controller.workspace!.relative(absolute);
    return relative ? { absolute, relative } : undefined;
  }
  pi.registerTool({
    ...read,
    async execute(id, params, signal, update, ctx) {
      const target = routed(params.path, ctx);
      if (!target) return createReadToolDefinition(ctx.cwd).execute(id, params, signal, update, ctx);
      const workspace = controller.workspace!;
      return managed(ctx, async () => {
        const memoryRead = createReadToolDefinition(ctx.cwd, { operations: {
          readFile: (path) => workspace.read(path),
          access: async (path) => { await workspace.read(path); },
          detectImageMimeType: async () => undefined,
        } });
        return memoryRead.execute(id, params, signal, update, ctx);
      });
    },
  });
  pi.registerTool({
    ...edit,
    async execute(id, params, signal, update, ctx) {
      const target = routed(params.path, ctx);
      if (!target) return createEditToolDefinition(ctx.cwd).execute(id, params, signal, update, ctx);
      const workspace = controller.workspace!;
      return managed(ctx, async () => {
        const changes = new Map<string, Buffer | null>();
        // Stage the host's matching, BOM and newline handling before durable commit.
        const staged = createEditToolDefinition(ctx.cwd, { operations: {
          readFile: (path) => workspace.read(path),
          access: async (path) => { await workspace.read(path); },
          writeFile: async (_path, content) => { changes.set(target.relative, Buffer.from(content)); },
        } });
        const result = await staged.execute(id, params, signal, update, ctx);
        signal?.throwIfAborted();
        const snapshot = await workspace.commit(changes, signal);
        return { ...result, content: [...result.content,
          { type: "text" as const, text: `实际生效的差异：\n${result.details?.diff ?? ""}` }],
          details: { ...result.details!, inmemory: { taskId: controller.task?.id, path: target.relative, snapshotId: snapshot.id } } };
      });
    },
  });
  pi.registerTool<typeof write.parameters, unknown>({
    ...write,
    renderResult: undefined,
    // Widen the stock tool's undefined-only details to include recovery references.
    parameters: write.parameters,
    async execute(id, params, signal, update, ctx) {
      const target = routed(params.path, ctx);
      if (!target) return createWriteToolDefinition(ctx.cwd).execute(id, params, signal, undefined, ctx);
      const workspace = controller.workspace!;
      return managed(ctx, async () => {
        const changes = new Map<string, Buffer | null>();
        const staged = createWriteToolDefinition(ctx.cwd, { operations: {
          mkdir: async () => undefined,
          writeFile: async (_path, content) => { changes.set(target.relative, Buffer.from(content)); },
        } });
        const result = await staged.execute(id, params, signal, undefined, ctx);
        signal?.throwIfAborted();
        const snapshot = await workspace.commit(changes, signal);
        return { ...result, details: { inmemory: { taskId: controller.task?.id, path: target.relative, snapshotId: snapshot.id } } };
      });
    },
  });
  pi.registerTool({
    name: "memory_delete", label: "Delete managed file", description: "删除一个托管文本文件，保留可由 /tree 恢复的版本。",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      const target = routed(params.path, ctx);
      if (!target) throw new Error("memory_delete 只处理启用中的托管文件。");
      const workspace = controller.workspace!;
      return managed(ctx, async () => {
        await workspace.read(target.absolute);
        const snapshot = await workspace.commit(new Map([[target.relative, null]]), signal);
        return { content: [{ type: "text", text: `已删除 ${JSON.stringify(target.relative)}。` }], details: { snapshotId: snapshot.id } };
      });
    },
  });
  pi.registerTool({
    name: "memory_move", label: "Move managed file", description: "移动或重命名托管文件；源和目标必须都在托管范围内，目标必须不存在。",
    parameters: Type.Object({ from: Type.String(), to: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      const from = routed(params.from, ctx);
      const to = routed(params.to, ctx);
      if (!from || !to) throw new Error("移动的源和目标必须都是托管文本路径。");
      const workspace = controller.workspace!;
      return managed(ctx, async () => {
        if (workspace.working.contents.has(to.relative)) throw new Error("目标文件已存在。");
        const bytes = await workspace.read(from.absolute);
        const permissions = new Map([[to.relative, workspace.working.manifest.files[from.relative]!.mode]]);
        const snapshot = await workspace.commit(new Map([[from.relative, null], [to.relative, bytes]]), signal, permissions);
        return { content: [{ type: "text", text: `已将 ${JSON.stringify(from.relative)} 移到 ${JSON.stringify(to.relative)}。` }], details: { snapshotId: snapshot.id } };
      });
    },
  });
}
