import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Controller } from "./controller.ts";
import { fileChanges } from "./external-changes.ts";
import { validateRelative } from "./files.ts";
import { IDE_MAX_REQUEST_BYTES, isIdeRequest, type IdeConnection, type IdeRequest, type IdeResult, type IdeState } from "./ide-protocol.ts";
import { errorText, SerialQueue, type Snapshot } from "./types.ts";
import type { Workspace } from "./workspace.ts";

export function ideRegistryDirectory(): string {
  return process.env.PI_INMEMORY_IDE_DIR ?? join(tmpdir(), `pi-inmemory-ide-${process.getuid?.() ?? "user"}`);
}

interface Pending {
  request: IdeRequest;
  resolve(result: IdeResult): void;
  reject(error: Error): void;
}

/** The terminal remains Pi's UI. Only explicit, authenticated IDE requests enter here. */
export class IdeBridge {
  private server?: Server;
  private descriptor?: string;
  private context?: ExtensionContext;
  private readonly instanceId = randomUUID();
  private readonly token = randomUUID() + randomUUID();
  private readonly queue = new SerialQueue();
  private readonly pending = new Map<string, Pending>();
  private readonly results = new Map<string, { body: string; result: Promise<IdeResult> }>();
  private readonly external = new WeakMap<Workspace, { id: string; snapshot: Snapshot }>();
  private closing = false;
  private startupFailure?: string;

  private readonly pi: ExtensionAPI;
  private readonly controller: Controller;

  constructor(pi: ExtensionAPI, controller: Controller) {
    this.pi = pi;
    this.controller = controller;
    pi.registerCommand("inmem-ide", {
      description: "Internal VS Code action entry point; use the IDE menus",
      handler: async (id, ctx) => {
        const pending = this.pending.get(id.trim());
        if (!pending) return;
        this.pending.delete(id.trim());
        this.context = ctx;
        try { pending.resolve(await this.execute(pending.request, ctx)); }
        catch (error) { pending.reject(new Error(errorText(error))); }
      },
    });
  }

  update(ctx: ExtensionContext): void { this.context = ctx; }

  async start(ctx: ExtensionContext): Promise<void> {
    this.update(ctx);
    if (this.server || this.closing || (ctx.mode !== "tui" && !process.env.PI_INMEMORY_IDE_DIR)) return;
    const directory = ideRegistryDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => this.respond(response, 400, { error: errorText(error) }));
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Cannot create the local IDE bridge.");
    const connection: IdeConnection = { version: 1, instanceId: this.instanceId, pid: process.pid,
      port: address.port, token: this.token, cwd: ctx.cwd, terminalId: process.env.PI_INMEMORY_TERMINAL_ID };
    this.descriptor = join(directory, `${this.instanceId}.json`);
    try { await writeFile(this.descriptor, JSON.stringify(connection), { mode: 0o600, flag: "wx" }); }
    catch (error) { await this.close(); throw error; }
    server.unref();
    const directoryToMount = process.env.PI_INMEMORY_MOUNT;
    if (directoryToMount && !this.controller.enabled) {
      const initial: IdeRequest = { id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId(), action: { type: "mount", directory: directoryToMount } };
      setTimeout(() => {
        void this.queue.run(() => this.dispatch(initial)).catch((error) => {
          this.startupFailure = errorText(error);
          ctx.ui.notify(`IDE mount failed: ${this.startupFailure}`, "error");
        });
      }, 0).unref();
    }
  }

  private respond(response: ServerResponse, status: number, value: unknown): void {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = request.headers.authorization ?? "";
    const expected = `Bearer ${this.token}`;
    if (request.headers.origin || Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) {
      this.respond(response, 403, { error: "Connection authentication failed." }); return;
    }
    if (request.method === "GET" && request.url === "/state") {
      this.respond(response, 200, await this.state()); return;
    }
    if (request.method !== "POST" || request.url !== "/command") {
      this.respond(response, 404, { error: "Unknown operation." }); return;
    }
    if (this.closing) throw new Error("Pi is shutting down.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk);
      if (size > IDE_MAX_REQUEST_BYTES) { this.respond(response, 413, { error: "The selection is too large. Select less text." }); return; }
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const operation: unknown = JSON.parse(body);
    if (!isIdeRequest(operation)) throw new Error("Invalid IDE request.");
    let cached = this.results.get(operation.id);
    if (cached && cached.body !== body) throw new Error("The request ID has already been used for another operation.");
    if (!cached) {
      if (this.pending.size >= 20) throw new Error("Too many pending operations. Try again shortly.");
      const result = this.queue.run(() => this.dispatch(operation));
      cached = { body, result };
      this.results.set(operation.id, cached);
      // Keep recent receipts for retries; never evict an operation that is still executing.
      void result.finally(() => {
        if (this.results.size > 100) this.results.delete(this.results.keys().next().value!);
      }).catch(() => {});
    }
    try { this.respond(response, 200, await cached.result); }
    catch (error) { this.respond(response, 409, { error: errorText(error) }); }
  }

  private dispatch(request: IdeRequest): Promise<IdeResult> {
    if (this.closing) return Promise.reject(new Error("Pi has exited."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request.id); reject(new Error("Pi did not respond to the operation. Check the terminal.")); }, 10000);
      this.pending.set(request.id, { request,
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); } });
      this.pi.sendUserMessage(`/inmem-ide ${request.id}`, { expandPromptTemplates: true });
    });
  }

  async state(): Promise<IdeState> {
    const ctx = this.context;
    if (!ctx) throw new Error("Pi is not ready yet.");
    const workspace = this.controller.workspace;
    const state: IdeState = { version: 1, instanceId: this.instanceId, sessionId: ctx.sessionManager.getSessionId(),
      sessionName: this.pi.getSessionName(), leafId: ctx.sessionManager.getLeafId(), cwd: ctx.cwd,
      mode: this.controller.enabled ? workspace?.mode ?? "needs-recovery" : "ordinary", busy: !ctx.isIdle(),
      canMount: !this.controller.enabled && !ctx.sessionManager.getEntries().some((entry) =>
        ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type)),
      files: Object.keys(workspace?.working?.manifest.files ?? {}).sort(), changes: [], root: workspace?.config.root,
      checkedAt: workspace?.lastCheckedAt, workingId: workspace?.working?.id,
      externalSnapshotId: workspace?.externalSnapshotId, reason: workspace?.failure ?? this.startupFailure };
    if (workspace?.externalSnapshotId && workspace.working) {
      const snapshot = await this.externalSnapshot(workspace);
      state.changes = fileChanges(workspace.working, snapshot).map((change) => ({ ...change,
        permissionsChanged: change.kind === "modified" &&
          workspace.working.manifest.files[change.path]!.mode !== snapshot.manifest.files[change.path]!.mode }));
    }
    return state;
  }

  private async externalSnapshot(workspace: Workspace): Promise<Snapshot> {
    const id = workspace.externalSnapshotId!;
    let cached = this.external.get(workspace);
    if (!cached || cached.id !== id) {
      cached = { id, snapshot: await workspace.store.loadSnapshot(id) };
      this.external.set(workspace, cached);
    }
    return cached.snapshot;
  }

  private async execute(request: IdeRequest, ctx: ExtensionCommandContext): Promise<IdeResult> {
    if (request.sessionId !== ctx.sessionManager.getSessionId() || request.leafId !== ctx.sessionManager.getLeafId()) {
      throw new Error("The Pi session or session position has changed. Refresh and try again.");
    }
    const action = request.action;
    if (action.type === "selection") {
      const ready = !this.controller.enabled || this.controller.workspace?.mode === "ready";
      if (action.destination === "send" && ctx.isIdle() && ready && !ctx.hasPendingMessages() && !ctx.ui.getEditorText().trim()) {
        this.pi.sendUserMessage(action.text, { expandPromptTemplates: false });
        return { message: "Submitted to Pi. Check the terminal for the result.", disposition: "submitted" };
      }
      this.controller.stageIdeText(action.text, ctx);
      return { message: action.destination === "send" ? "Pi is busy, needs recovery or already has a draft. The selection was added to the input and has not been sent." : "Added to the Pi input. Not sent yet.", disposition: "draft" };
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the current task to finish before changing the mount or file versions.");
    if (action.type === "mount") {
      await this.controller.command(`on ${action.directory}`, ctx);
      return { message: "Directory mounted." };
    }
    const workspace = this.controller.workspace;
    if (!workspace?.working) throw new Error("No usable directory is mounted.");
    if (action.type === "check") {
      await this.controller.checkExternal(ctx);
      return { message: workspace.mode === "ready" ? "Check complete. Files match the Pi records." : "Pending changes found. Review the file list." };
    }
    if (action.workingId !== workspace.working.id || action.externalSnapshotId !== workspace.externalSnapshotId) {
      throw new Error("The file versions have changed. Check again and review the diff before deciding.");
    }
    if (action.type === "diff" || action.type === "diffs") {
      const snapshot = await this.externalSnapshot(workspace);
      const paths = action.type === "diff" ? [action.path] : fileChanges(workspace.working, snapshot).map((change) => change.path);
      const diffs = paths.map((path) => {
        validateRelative(path);
        if (!workspace.working.contents.has(path) && !snapshot.contents.has(path)) throw new Error("The file does not belong to the current versions.");
        return { path, before: workspace.working.contents.get(path)?.toString("utf8") ?? "",
          after: snapshot.contents.get(path)?.toString("utf8") ?? "",
          beforeExists: workspace.working.contents.has(path), afterExists: snapshot.contents.has(path),
          beforeMode: workspace.working.manifest.files[path]?.mode, afterMode: snapshot.manifest.files[path]?.mode };
      });
      return { message: "The diff uses the two versions recorded by Pi.", ...(action.type === "diff" ? { diff: diffs[0] } : { diffs }) };
    }
    // A decision applies only to the disk version the user has just inspected.
    if (workspace.externalSnapshotId && (await workspace.disk()).id !== workspace.externalSnapshotId) {
      await this.controller.checkExternal(ctx);
      throw new Error("Disk files changed again. The change list was updated; review it and choose again.");
    }
    await this.controller.command(action.type, ctx);
    return { message: action.type === "sync" ? "External changes accepted. Waiting for a new instruction." : "External changes discarded. Successful assistant edits are preserved." };
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const pending of this.pending.values()) pending.reject(new Error("Pi has exited."));
    this.pending.clear();
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    if (this.descriptor) await rm(this.descriptor, { force: true });
  }
}
