import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BeforeAgentStartUserEvent, BoundaryResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { mountConfig } from "./files.ts";
import { preserveTaskCache, type CacheAnchor } from "./anthropic-cache.ts";
import { checkpointEntry, completedOmissions, estimatedTokens, project, STATE_TYPE, workspaceMessage } from "./projection.ts";
import { Store, type Transaction } from "./store.ts";
import { errorText, type Checkpoint, type Omission, type TaskState } from "./types.ts";
import { Workspace } from "./workspace.ts";
import type { SessionTreeOpenEvent } from "./tree-api.ts";
import { selectableTree, visibleLeaf } from "./tree-view.ts";
import { sessionType } from "./session-list.ts";
import { EXTERNAL_CHANGE_TYPE, EXTERNAL_CHOICE, fileChanges } from "./external-changes.ts";
import { Drafts, INSTRUCTION_TYPE, type Draft } from "./drafts.ts";

interface TreeTarget { checkpoint: Checkpoint; leafId: string | null }
interface PreparedTree extends TreeTarget { transaction: Transaction }

function sameRecoveryState(left: Checkpoint, right: Checkpoint): boolean {
  const state = (checkpoint: Checkpoint) => ({
    sessionId: checkpoint.sessionId, config: checkpoint.config,
    workingId: checkpoint.workingId, baselineId: checkpoint.baselineId,
    task: checkpoint.task, omissions: checkpoint.omissions, enabled: checkpoint.enabled, pendingExternal: checkpoint.pendingExternal,
    externalSnapshotId: checkpoint.externalSnapshotId,
  });
  return JSON.stringify(state(left)) === JSON.stringify(state(right));
}

export class Controller {
  workspace?: Workspace;
  task?: TaskState;
  omissions: Omission[] = [];
  private prepared?: PreparedTree;
  private blocked?: string;
  private lastOutcome: "completed" | "aborted" | "error" = "error";
  private lastCheckpoint?: Checkpoint;
  private cacheUsage?: { input: number; cacheRead: number; cacheWrite: number; provider: string; model: string };
  private cacheAnchor?: CacheAnchor;
  private memorySession = false;
  private submissionNavigation?: { leafId: string; moved: boolean };
  private starting?: Draft;
  private runStarted = false;
  private readonly drafts: Drafts;

  readonly pi: ExtensionAPI;
  constructor(pi: ExtensionAPI) { this.pi = pi; this.drafts = new Drafts(pi); }

  get enabled(): boolean { return this.memorySession; }

  input(event: InputEvent, ctx: ExtensionContext): InputEventResult {
    if (!this.enabled) return { action: "continue" };
    return this.drafts.capture(event, ctx, this.workspace?.mode === "ready", this.workspace?.failure ?? this.blocked);
  }

  prepare(event: BeforeAgentStartUserEvent): void {
    if (!this.enabled) return;
    this.starting = this.drafts.submission;
    if (!this.starting) throw new Error(`未保存待执行指令：${event.prompt.slice(0, 40)}`);
    this.runStarted = false;
  }

  stop(error: unknown, ctx: ExtensionContext): void {
    const message = errorText(error);
    const repeated = this.blocked === message;
    this.blocked = message;
    if (!this.runStarted && this.starting) this.drafts.blockSubmission(this.starting.id);
    if (this.runStarted && this.task?.status === "running") {
      this.task.status = "incomplete";
      this.task.outcome = "aborted";
      if (this.workspace?.externalChange) this.task.interruption = "external-change";
    }
    if (this.workspace) {
      this.workspace.mode = "needs-recovery";
      this.workspace.failure = this.blocked;
    }
    ctx.abort();
    if (!repeated) {
      const externalChange = this.workspace?.externalChange;
      const progress = this.starting && !this.runStarted ? "指令已保留，任务尚未开始。"
        : this.runStarted ? "任务已中断，尚未完成。" : undefined;
      ctx.ui.notify([
        externalChange ? "In Memory：等待处理外部修改" : "In Memory：任务已停止",
        progress,
        this.blocked,
      ].filter(Boolean).join("\n\n"), externalChange ? "warning" : "error");
    }
    this.status(ctx);
  }

  status(ctx: ExtensionContext): void {
    const workspace = this.workspace;
    ctx.ui.setStatus("inmemory", this.memorySession
      ? `Memory ${workspace?.mode ?? "needs-recovery"} · ${Object.keys(workspace?.working?.manifest.files ?? {}).length} files` : undefined);
  }

  async save(ctx: ExtensionContext, kind: Checkpoint["kind"], anchorId: string | null = null): Promise<Checkpoint> {
    const workspace = this.workspace!;
    const checkpoint: Checkpoint = {
      version: 1, id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), anchorId,
      config: workspace.config, workingId: workspace.working?.id ?? this.lastCheckpoint!.workingId,
      baselineId: workspace.baseline?.id ?? this.lastCheckpoint!.baselineId,
      task: this.task ? structuredClone(this.task) : undefined, omissions: structuredClone(this.omissions),
      enabled: true, kind, ...(workspace.mode === "needs-recovery" ? { pendingExternal: true } : {}),
      ...(workspace.mode === "needs-recovery" && workspace.externalSnapshotId ? { externalSnapshotId: workspace.externalSnapshotId } : {}),
    };
    await workspace.store.saveCheckpoint(checkpoint);
    this.pi.appendEntry(STATE_TYPE, checkpoint);
    this.lastCheckpoint = checkpoint;
    await workspace.finishTransactions();
    this.status(ctx);
    return checkpoint;
  }

  /** Called under the workspace lock after tool results have reached the transcript. */
  private async recordInterruption(ctx: ExtensionContext): Promise<void> {
    const workspace = this.workspace!;
    if (!workspace.working || !workspace.baseline) return;
    const report = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    const kind = this.task?.status === "incomplete" ? "interrupted" : "position";
    const checkpoint = await this.save(ctx, kind, report?.id ?? null);
    if (checkpoint.task?.status === "incomplete") {
      this.pi.setLabel(ctx.sessionManager.getLeafId()!, "Memory：任务未完成");
    }
  }

  /** Exact report anchors can have metadata appended after the selected report itself. */
  resolve(ctx: ExtensionContext, leafId: string | null, strict = true): Checkpoint | undefined {
    if (!leafId) return undefined;
    const all = ctx.sessionManager.getEntries();
    const records = all.filter(checkpointEntry).filter((entry) => entry.data?.sessionId === ctx.sessionManager.getSessionId());
    const indexed = new Map<string, Checkpoint>();
    for (const entry of records) {
      const checkpoint = entry.data!;
      if (checkpoint.anchorId && ["settled", "turn", "compaction"].includes(checkpoint.kind)) indexed.set(checkpoint.anchorId, checkpoint);
    }
    for (const entry of ctx.sessionManager.getBranch(leafId).reverse()) {
      if (checkpointEntry(entry) && entry.data!.sessionId === ctx.sessionManager.getSessionId()) return entry.data;
      const exact = indexed.get(entry.id);
      if (exact) return exact;
      if (strict && entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
        // An unsupported intermediate model/tool node must not silently inherit an older version.
        throw new Error("该节点没有稳定检查点，请选择带 Memory 标签的任务汇报或任务指令。");
      }
    }
    return undefined;
  }

  async initialize(ctx: ExtensionContext): Promise<void> {
    const previous = this.workspace;
    if (previous) await previous.queue.run(() => previous.ownership.release());
    this.workspace = undefined;
    this.task = undefined;
    this.omissions = [];
    this.blocked = undefined;
    this.prepared = undefined;
    this.submissionNavigation = undefined;
    this.starting = undefined;
    this.runStarted = false;
    this.drafts.load(ctx.sessionManager.getBranch());
    this.memorySession = sessionType(ctx.sessionManager.getEntries()) === "inmemory";
    if (!this.memorySession) { this.lastCheckpoint = undefined; this.status(ctx); return; }
    const selected = this.resolve(ctx, ctx.sessionManager.getLeafId(), false);
    const checkpoint = selected ?? ctx.sessionManager.getEntries().filter(checkpointEntry)
      .findLast((entry) => entry.data!.sessionId === ctx.sessionManager.getSessionId())?.data;
    this.lastCheckpoint = checkpoint;
    if (!checkpoint) throw new Error("这是 InMemory 会话，但没有属于当前会话的检查点。请新建 InMemory 会话，不要按普通会话继续。");
    const workspace = new Workspace(checkpoint.config, checkpoint.sessionId);
    this.workspace = workspace;
    if (checkpoint.config.cwd !== await realpath(ctx.cwd)) throw new Error("项目位置已改变，请在原项目中恢复，或新建 InMemory 会话绑定目录。");
    const lastState = ctx.sessionManager.getBranch().findLast((entry) => checkpointEntry(entry) ||
      (entry.type === "custom" && entry.customType === "inmemory.position"));
    const interrupted = lastState?.type === "custom" && lastState.customType === "inmemory.position" &&
      (lastState.data as { needsRecovery?: boolean } | undefined)?.needsRecovery;
    if (!selected?.enabled) {
      workspace.failure = `这是 InMemory 专用会话，当前位置来自旧版普通模式或待恢复状态。\n\n${EXTERNAL_CHOICE}`;
      ctx.ui.notify(workspace.failure, "warning");
      this.status(ctx);
      return;
    }
    await workspace.store.verifyCheckpoint(checkpoint);
    workspace.working = await workspace.store.loadSnapshot(checkpoint.workingId);
    workspace.baseline = await workspace.store.loadSnapshot(checkpoint.baselineId);
    this.task = checkpoint.task ? structuredClone(checkpoint.task) : undefined;
    this.omissions = structuredClone(checkpoint.omissions);
    await workspace.ownership.acquire(workspace.config.root);
    const pending = await workspace.store.pendingTransactions();
    if (pending.length || checkpoint.pendingExternal || interrupted) {
      workspace.externalChange = !!checkpoint.pendingExternal;
      workspace.externalSnapshotId = checkpoint.externalSnapshotId;
      const reasons = [
        ...(checkpoint.pendingExternal || interrupted ? ["会话上次保存了尚未处理的状态"] : []),
        ...(pending.length ? [`目录的文件操作日志有 ${pending.length} 条未完成记录`] : []),
      ];
      workspace.failure = [
        `${reasons.join("；")}。本次恢复没有比较磁盘文件。`,
        await workspace.knownExternalChanges(),
        EXTERNAL_CHOICE,
      ].filter(Boolean).join("\n\n");
    } else workspace.mode = "ready";
    if (this.task?.status === "running") {
      this.task.status = "incomplete";
      if (workspace.externalChange) this.task.interruption = "external-change";
    }
    if (workspace.mode === "ready") this.drafts.restore(ctx);
    this.status(ctx);
  }

  async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.isIdle()) throw new Error("请先等待当前任务结束，或停止任务后再操作 /memory。");
    const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const action = match?.[1] ?? "status";
    let argument = match?.[2]?.trim() ?? "";
    if ((argument.startsWith('"') && argument.endsWith('"')) || (argument.startsWith("'") && argument.endsWith("'"))) argument = argument.slice(1, -1);
    if (action === "status") {
      const workspace = this.workspace;
      const taskLabels = { running: "进行中", completed: "已完成", incomplete: "未完成" };
      ctx.ui.notify(workspace ? [
        "会话类型：InMemory", `In Memory：${workspace.mode}`, `目录：${workspace.config.root}`,
        `托管文件：${Object.keys(workspace.working?.manifest.files ?? {}).length} 个`,
        `任务：${this.task ? taskLabels[this.task.status] : "无"}`,
        `工作快照：${workspace.working?.id.slice(0, 12) ?? "不可用"}`,
        `任务基线：${workspace.baseline?.id.slice(0, 12) ?? "不可用"}`,
        `已精简历史工具调用：${this.omissions.length} 次`,
        ...(this.cacheUsage ? [`最近缓存读取：${this.cacheUsage.cacheRead} tokens；写入：${this.cacheUsage.cacheWrite} tokens（宿主报告）`] : []),
        ...(workspace.recoveryBackupId ? [`恢复备份：${workspace.recoveryBackupId}`] : []),
        ...((workspace.failure ?? this.blocked) ? [`说明：${workspace.failure ?? this.blocked}`] : []),
      ].join("\n") : `会话类型：${this.memorySession ? "InMemory（待恢复）" : "普通"}${this.blocked ? `\n说明：${this.blocked}` : ""}`, "info");
      return;
    }
    if (action === "off") throw new Error("InMemory 是会话的固定类别，不能通过 /memory off 转为普通会话。请使用 /new 新建普通会话，或 /resume 进入已有普通会话。");
    if (action === "on") {
      if (this.memorySession) throw new Error("当前已经是 InMemory 会话。如需恢复请使用 /memory recover；如需绑定其他目录，请先 /new 新建会话。");
      if (ctx.sessionManager.getEntries().some((entry) => ["message", "custom_message", "compaction", "branch_summary"].includes(entry.type))) {
        throw new Error("已经开始聊天的普通会话不能转为 InMemory。请先 /new，再在首次聊天前执行 /memory on [目录]。");
      }
      const config = await mountConfig(ctx.cwd, argument || ".");
      const workspace = new Workspace(config, ctx.sessionManager.getSessionId());
      const excluded = await workspace.mount();
      this.workspace = workspace;
      this.memorySession = true;
      this.task = undefined;
      this.omissions = [];
      this.blocked = undefined;
      await this.save(ctx, "mount");
      this.pi.setLabel(ctx.sessionManager.getLeafId()!, "Memory：初始挂载");
      ctx.ui.notify(`已挂载 ${config.root}\n纳入：${Object.keys(workspace.working.manifest.files).join("、") || "（暂无文件）"}\n排除：${excluded.join("；") || "（无）"}`, "info");
      return;
    }
    const workspace = this.workspace;
    if (!workspace) throw new Error("尚未挂载目录，请先 /memory on [目录]。");
    if (["save-change", "continue"].includes(action)) throw new Error(`外部修改处理已收敛为两个命令。\n\n${EXTERNAL_CHOICE}`);
    if (["sync", "recover"].includes(action) && argument) {
      throw new Error(`这两个命令不接受参数。\n\n${EXTERNAL_CHOICE}`);
    }
    if (["sync", "recover"].includes(action)) await this.rollbackSubmission(ctx);
    await workspace.queue.run(async () => {
      if (action === "sync") {
        await this.acceptExternal(ctx);
      } else if (action === "recover") {
        await workspace.ownership.acquire(workspace.config.root);
        if (!workspace.working && this.lastCheckpoint) {
          workspace.working = await workspace.store.loadSnapshot(this.lastCheckpoint.workingId);
        }
        try {
          await workspace.recover(false);
          this.task = undefined;
          // Persist cleared recovery state and finish journals without adding a new tree restore point.
          await this.save(ctx, "position");
        } catch (error) { this.stop(error, ctx); throw error; }
        this.blocked = undefined;
        ctx.ui.notify("已撤销外部修改，保留助手已成功的修改，等待新指令。\n\n如需撤销助手的修改：\n  • /tree：选择要恢复的位置。", "info");
      } else throw new Error("用法：/memory on [目录] | status | sync | recover");
    });
    this.drafts.restore(ctx);
  }

  private async rollbackSubmission(ctx: ExtensionCommandContext): Promise<void> {
    const draft = this.drafts.blockedSubmission;
    if (!draft) return;
    if (!draft.beforeEntryId || !this.resolve(ctx, draft.beforeEntryId, false)?.enabled) {
      throw new Error("待执行指令的原会话位置不可用，已保留草稿，请先检查会话记录。");
    }
    this.submissionNavigation = { leafId: draft.beforeEntryId, moved: false };
    try {
      const result = await ctx.navigateTree(draft.beforeEntryId, { summarize: false });
      if (result.cancelled || !this.submissionNavigation.moved) {
        throw new Error("未能退回待提交指令之前，草稿和文件已保留。");
      }
    } finally { this.submissionNavigation = undefined; }
  }

  private async acceptExternal(ctx: ExtensionContext): Promise<void> {
    const workspace = this.workspace!;
    const before = workspace.working;
    const oldBaseline = workspace.baseline;
    const oldTask = this.task;
    const oldOmissions = this.omissions;
    const checkpoint = this.lastCheckpoint;
    const disk = await workspace.disk();
    if (workspace.mode === "ready" && disk.id === before.id) {
      ctx.ui.notify("没有待保存的外部修改。", "info");
      return;
    }
    const changes = fileChanges(before, disk);
    const changeId = randomUUID();
    const kinds = { added: "新增", modified: "修改", deleted: "删除" };
    try {
      await workspace.ownership.acquire(workspace.config.root);
      await workspace.recover(true);
      // A second external save during this command must be decided separately.
      if (workspace.working.id !== disk.id) throw new Error(`接纳期间文件再次变化。\n\n${EXTERNAL_CHOICE}`);
      await workspace.consistent();
      const additions = this.task ? completedOmissions(ctx.sessionManager.getBranch(), this.task, disk.id) : [];
      this.omissions = [...this.omissions, ...additions];
      this.task = undefined;
      this.pi.sendMessage({ customType: EXTERNAL_CHANGE_TYPE, display: true,
        content: "外部修改已由用户通过 /memory sync 接纳，不是助手的工具修改。\n" +
          (changes.map((change) => `${kinds[change.kind]} ${JSON.stringify(change.path)}`).join("\n") || "已确认使用当前磁盘文件。") +
          "\n以上路径相对托管目录；文件正文以新任务快照为准。",
        details: { version: 1, changeId, root: workspace.config.root, fromId: before?.id,
          toId: disk.id, changes },
      }, { triggerTurn: false });
      const message = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom_message" &&
        entry.customType === EXTERNAL_CHANGE_TYPE && (entry.details as { changeId?: string } | undefined)?.changeId === changeId);
      if (!message) throw new Error("外部修改消息尚未保存，不能提交新的文件状态。");
      await this.save(ctx, "external");
      this.pi.setLabel(ctx.sessionManager.getLeafId()!, "Memory：外部修改");
      this.blocked = undefined;
      ctx.ui.notify("已保留外部修改，并保存外部修改消息。可以重新提交任务。", "info");
    } catch (error) {
      if (this.lastCheckpoint === checkpoint) {
        workspace.working = before;
        workspace.baseline = oldBaseline;
        this.task = oldTask;
        this.omissions = oldOmissions;
      }
      this.stop(error, ctx);
      throw error;
    }
  }

  private async begin(ctx: ExtensionContext): Promise<void> {
    const workspace = this.workspace!;
    const nextBaseline = workspace.working;
    await workspace.store.saveSnapshot(nextBaseline);
    const additions = this.task ? completedOmissions(ctx.sessionManager.getBranch(), this.task, nextBaseline.id) : [];
    for (const omission of additions) await workspace.store.loadSnapshot(omission.snapshotId);
    this.omissions = [...this.omissions, ...additions];
    workspace.baseline = nextBaseline;
    this.task = { id: randomUUID(), anchorId: null, afterEntryId: this.starting!.beforeEntryId,
      timestamp: Date.now(), status: "running" };
    this.runStarted = true;
    this.lastOutcome = "error";
    await this.save(ctx, "task-start");
  }

  async context(messages: AgentMessage[], ctx: ExtensionContext): Promise<AgentMessage[]> {
    if (!this.enabled) {
      if (this.blocked) throw new Error(this.blocked);
      return messages;
    }
    const workspace = this.workspace!;
    return workspace.queue.run(async () => {
      workspace.assertReady();
      if (this.starting && !this.runStarted) {
        // Checkpoint 1: compare once before starting a new task; continuations keep its frozen baseline.
        await workspace.consistent();
        await this.begin(ctx);
      }
      const task = this.task;
      if (!task || task.status !== "running") throw new Error("缺少活动用户任务，请先提交一条新指令。");
      const branch = ctx.sessionManager.getBranch();
      let start = task.afterEntryId ? branch.findIndex((entry) => entry.id === task.afterEntryId) + 1 : 0;
      if (task.anchorId) start = branch.findIndex((entry) => entry.id === task.anchorId);
      const anchor = branch.slice(Math.max(0, start)).find((entry) => entry.type === "message" && entry.message.role === "user");
      if (!anchor || anchor.type !== "message") throw new Error("无法定位本次真实用户指令。");
      task.anchorId = anchor.id;
      const projectionEntries = ctx.sessionManager.buildSessionProjection().entries;
      const projectedAnchorIndex = projectionEntries.findIndex((entry) => entry.sourceEntry.id === anchor.id);
      const anchorOccurrence = projectionEntries.slice(0, projectedAnchorIndex).flatMap((entry) => entry.messages)
        .filter((message) => message.role === "user" && message.timestamp === anchor.message.timestamp).length;
      const visible = messages.filter((message) => message.role !== "custom" || message.customType !== INSTRUCTION_TYPE ||
        this.drafts.canDeliver((message.details as { draftId?: string } | undefined)?.draftId));
      const result = project(visible, workspace.baseline, task, this.omissions, workspace.config, anchor.message.timestamp, anchorOccurrence);
      const window = ctx.model?.contextWindow;
      if (!window) throw new Error("模型上下文容量尚不明确，不能发送托管文件快照。");
      const snapshotEstimate = estimatedTokens(workspaceMessage(workspace.baseline, task, workspace.config));
      const snapshotBudget = Math.min(workspace.config.maxSnapshotTokens, Math.floor(window * 0.25));
      if (snapshotEstimate > snapshotBudget) throw new Error(`文件快照估算 ${snapshotEstimate} tokens，超过预算 ${snapshotBudget}；请缩小托管范围或调整配置。`);
      const outputReserve = Math.min(ctx.model!.maxTokens, Math.floor(window * 0.2));
      if (estimatedTokens(result) + outputReserve > window * 0.9) throw new Error("估算上下文容量不足，已停止请求；文件全文未截断。请结束任务后压缩历史或缩小范围。");
      this.drafts.acceptInstructions(branch);
      if (this.starting) { this.drafts.submitted(this.starting.id); this.starting = undefined; }
      return result;
    });
  }

  async turn(ctx: ExtensionContext, outcome: "completed" | "aborted" | "error", anchorId: string): Promise<BoundaryResult | void> {
    if (!this.enabled || !this.runStarted) return;
    this.lastOutcome = outcome;
    const workspace = this.workspace!;
    return workspace.queue.run(async () => {
      if (workspace.mode !== "ready") return;
      await this.save(ctx, "turn", anchorId);
      if (outcome !== "completed") return;
      const report = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      const toolsPending = report?.type === "message" && report.message.role === "assistant" &&
        report.message.content.some((block) => block.type === "toolCall");
      const draft = this.drafts.nextInstruction(ctx.sessionManager.getBranch(), !!toolsPending);
      if (draft) return { entries: [{ type: "custom_message", customType: INSTRUCTION_TYPE, display: true,
        content: [{ type: "text", text: draft.text }, ...(draft.images ?? [])], details: { draftId: draft.id } }], continue: true };
    });
  }

  async settle(ctx: ExtensionContext, aborted: boolean): Promise<void> {
    if (!this.enabled) return;
    const workspace = this.workspace!;
    await workspace.queue.run(async () => {
      if (!this.runStarted) {
        if (workspace.mode !== "ready") await this.save(ctx, "position");
        this.starting = undefined;
        return;
      }
      // Checkpoint 3: final settlement, not every tool round.
      if (workspace.mode === "ready") {
        try { await workspace.consistent(); }
        catch (error) { this.stop(error, ctx); }
      }
      if (workspace.mode !== "ready") {
        this.task!.status = "incomplete";
        await this.recordInterruption(ctx);
        return;
      }
      this.task!.status = !aborted && this.lastOutcome === "completed" ? "completed" : "incomplete";
      this.task!.outcome = aborted ? "aborted" : this.lastOutcome;
      const report = ctx.sessionManager.getBranch().reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
      await this.save(ctx, "settled", report?.id ?? null);
      if (report) this.pi.setLabel(report.id, this.task!.status === "completed" ? "Memory：任务完成" : "Memory：任务未完成");
    });
    this.runStarted = false;
    if (workspace.mode === "ready") this.drafts.restore(ctx);
  }

  async beforeTree(ctx: ExtensionContext, targetId: string, summary: boolean): Promise<void> {
    if (!this.hasMemoryHistory(ctx)) return;
    if (this.submissionNavigation?.leafId === targetId) return;
    const { checkpoint, leafId } = this.treeTarget(ctx, targetId);
    if (summary) throw new Error("In Memory 的树切换不生成分支摘要。");
    if (checkpoint.config.cwd !== await realpath(ctx.cwd)) throw new Error("目标检查点属于其他项目位置。");
    const store = new Store(checkpoint.config);
    await store.verifyCheckpoint(checkpoint);
    if (!this.workspace) this.workspace = new Workspace(checkpoint.config, checkpoint.sessionId);
    const workspace = this.workspace;
    await workspace.queue.run(async () => {
      await workspace.ownership.acquire(workspace.config.root);
      // Tree restoration is a managed disk mutation, covered by checkpoint 2.
      const disk = await workspace.consistent();
      const targetSnapshot = await store.loadSnapshot(checkpoint.workingId);
      await workspace.validatePaths(disk, targetSnapshot);
      const transaction = store.transaction(checkpoint.sessionId, "tree", disk.id, checkpoint.workingId);
      transaction.oldLeafId = ctx.sessionManager.getLeafId();
      transaction.targetLeafId = leafId;
      await store.journal(transaction);
      this.prepared = { checkpoint, leafId, transaction };
      workspace.mode = "switching";
      this.status(ctx);
    });
  }

  async beforeSwitch(ctx: ExtensionContext): Promise<void> {
    if (!this.memorySession) return;
    if (!this.workspace || this.workspace.mode !== "ready") {
      if (this.workspace?.working && this.workspace.baseline) {
        await this.workspace.queue.run(() => this.save(ctx, "position"));
      } else this.pi.appendEntry("inmemory.position", { version: 1, needsRecovery: true });
      return;
    }
    const workspace = this.workspace!;
    await workspace.queue.run(async () => {
      // Pi resumes at the final persisted entry. Keep the selected route durable even
      // when files did not change, without presenting a bookkeeping-only restore point.
      await this.save(ctx, "position");
    });
  }

  private hasMemoryHistory(ctx: ExtensionContext): boolean {
    return this.enabled || ctx.sessionManager.getEntries().some(checkpointEntry);
  }

  private treeTarget(ctx: ExtensionContext, targetId: string): TreeTarget {
    const target = ctx.sessionManager.getEntry(targetId);
    if (!target) throw new Error("会话树目标不存在。");
    const user = target.type === "message" && target.message.role === "user";
    const report = target.type === "message" && target.message.role === "assistant" &&
      !target.message.content.some((block) => block.type === "toolCall");
    // Legacy recovery records remain readable for resume, but are administrative tree entries.
    const standalone = checkpointEntry(target) && ["mount", "sync", "external", "interrupted"].includes(target.data!.kind);
    if (!user && !report && !standalone && target.type !== "compaction") throw new Error("该节点不是可恢复的任务起点或稳定检查点。");
    // Older versions saved unchanged session departures as unlabeled sync entries.
    // Keep their raw records for resume, but collapse duplicate leaves in the tree.
    if (checkpointEntry(target) && target.data!.kind === "sync" && !ctx.sessionManager.getLabel(target.id)) {
      const previous = this.resolve(ctx, target.parentId, false);
      if (previous && sameRecoveryState(previous, target.data!)) throw new Error("该记录仅保存会话位置，没有新的恢复状态。");
    }
    const leafId = user ? target.parentId : target.id;
    const inherited = this.resolve(ctx, leafId, false);
    if (!inherited?.enabled) throw new Error("InMemory 会话只能选择有文件快照的 InMemory 位置，不能切回旧版普通模式位置。");
    const checkpoint = this.resolve(ctx, leafId)!;
    if (checkpoint.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("检查点不属于当前会话。");
    if (checkpoint.task?.status === "running" && !(user && checkpoint.kind === "task-start")) throw new Error("该任务尚未形成稳定检查点。");
    if (report && (checkpoint.kind !== "settled" || checkpoint.anchorId !== target.id)) throw new Error("该汇报尚未关联最终检查点。");
    if (this.workspace && this.workspace.config.root !== checkpoint.config.root) throw new Error("不支持跨挂载目录恢复；请新建 InMemory 会话绑定其他目录。");
    return { checkpoint, leafId };
  }

  async openTree(event: SessionTreeOpenEvent, ctx: ExtensionContext): Promise<void> {
    if (!this.hasMemoryHistory(ctx)) return;
    event.skipSummaryPrompt = true;
    event.initialFilterMode = "all";
    const cwd = await realpath(ctx.cwd);
    const allowed = new Set<string>();
    const verified = new Map<string, Promise<void>>();
    for (const entry of ctx.sessionManager.getEntries()) {
      try {
        const { checkpoint } = this.treeTarget(ctx, entry.id);
        if (checkpoint.config.cwd !== cwd) continue;
        let verification = verified.get(checkpoint.id);
        if (!verification) {
          verification = new Store(checkpoint.config).verifyCheckpoint(checkpoint);
          verified.set(checkpoint.id, verification);
        }
        await verification;
        allowed.add(entry.id);
      } catch { /* Unsupported or damaged targets do not appear in the selectable view. */ }
    }
    event.tree = selectableTree(event.tree, allowed);
    event.currentLeafId = visibleLeaf(ctx.sessionManager.getEntries(), event.currentLeafId, allowed);
  }

  async afterTree(ctx: ExtensionContext, actualLeafId: string | null): Promise<void> {
    if (this.submissionNavigation) {
      if (actualLeafId !== this.submissionNavigation.leafId) throw new Error("待提交指令的会话落点不一致。");
      this.submissionNavigation.moved = true;
      return;
    }
    if (!this.prepared) return;
    const prepared = this.prepared;
    this.prepared = undefined;
    // Pi may append a label after moving; it is harmless metadata on the actual target path.
    let leaf = actualLeafId ? ctx.sessionManager.getEntry(actualLeafId) : undefined;
    while (leaf?.type === "label") leaf = leaf.parentId ? ctx.sessionManager.getEntry(leaf.parentId) : undefined;
    if (actualLeafId !== prepared.leafId && (leaf?.id ?? null) !== prepared.leafId) {
      throw new Error("Pi 实际落点与准备的文件检查点不同，已停止托管操作。");
    }
    const workspace = this.workspace!;
    const checkpoint = prepared.checkpoint;
    await workspace.queue.run(async () => {
      const working = await workspace.store.loadSnapshot(checkpoint.workingId);
      const baseline = await workspace.store.loadSnapshot(checkpoint.baselineId);
      // The host already moved. Recovery must now target this branch, even if disk restore fails.
      workspace.working = working;
      workspace.baseline = baseline;
      this.task = checkpoint.task ? structuredClone(checkpoint.task) : undefined;
      if (this.task?.status === "running") this.task.status = "incomplete";
      this.omissions = structuredClone(checkpoint.omissions);
      this.lastCheckpoint = checkpoint;
      await workspace.restore(working, prepared.transaction);
      // Selecting an unfinished branch restores legitimate files but keeps the decision pending.
      workspace.externalChange = !!checkpoint.pendingExternal;
      workspace.externalSnapshotId = checkpoint.pendingExternal ? checkpoint.externalSnapshotId : undefined;
      workspace.mode = checkpoint.pendingExternal ? "needs-recovery" : "ready";
      workspace.failure = checkpoint.pendingExternal
        ? [await workspace.knownExternalChanges(), EXTERNAL_CHOICE].filter(Boolean).join("\n\n") : undefined;
      this.drafts.load(ctx.sessionManager.getBranch());
      this.drafts.restore(ctx);
      this.blocked = undefined;
      prepared.transaction.phase = "done";
      await workspace.store.journal(prepared.transaction);
      this.status(ctx);
    });
  }

  async compact(ctx: ExtensionContext, compactionId: string): Promise<void> {
    if (!this.enabled) return;
    const workspace = this.workspace!;
    await workspace.queue.run(async () => {
      workspace.assertReady();
      workspace.baseline = workspace.working;
      await this.save(ctx, "compaction", compactionId);
    });
  }

  async close(): Promise<void> {
    if (this.workspace) await this.workspace.queue.run(() => this.workspace!.ownership.release());
  }

  observeRequest(payload: unknown, ctx: ExtensionContext): unknown {
    if (!this.enabled || !this.runStarted || !this.task || !payload || typeof payload !== "object") return;
    const value = payload as Record<string, unknown>;
    if (ctx.model?.api !== "anthropic-messages" || !Array.isArray(value.messages)) return;
    const adapted = preserveTaskCache(payload, this.task.id, this.cacheAnchor);
    this.cacheAnchor = adapted.anchor;
    const messages = value.messages as Array<{ role?: string; content?: unknown }>;
    this.pi.appendEntry("inmemory.request", {
      version: 1, taskId: this.task.id, provider: ctx.model.provider, model: ctx.model.id,
      baselineId: this.workspace!.baseline.id, roles: messages.map((message) => message.role),
      contentBlocks: messages.map((message) => Array.isArray(message.content) ? message.content.length : 1),
    });
    return adapted.payload;
  }

  observeUsage(message: AgentMessage): void {
    if (!this.enabled || !this.runStarted || message.role !== "assistant") return;
    this.cacheUsage = { input: message.usage.input, cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite, provider: message.provider, model: message.model };
    this.pi.appendEntry("inmemory.usage", { version: 1, taskId: this.task?.id, ...this.cacheUsage });
  }
}
