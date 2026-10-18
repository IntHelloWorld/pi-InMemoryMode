import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, hash, isMissing, snapshotFrom } from "./files.ts";
import type { Checkpoint, Manifest, MountConfig, Snapshot } from "./types.ts";

export interface Transaction {
  version: 1;
  id: string;
  sessionId: string;
  kind: "write" | "tree" | "recovery";
  fromId: string;
  toId: string;
  oldLeafId?: string | null;
  targetLeafId?: string | null;
  phase: "prepared" | "files-applied" | "state-committed" | "done";
}

function objectId(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("无效的内容对象引用。");
  return id;
}

export class Store {
  readonly directory: string;
  readonly config: MountConfig;

  constructor(config: MountConfig) {
    this.config = config;
    this.directory = join(config.cwd, ".pi/inmemory", hash(config.root).slice(0, 24));
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    for (const [path, bytes] of snapshot.contents) {
      await this.put("objects", snapshot.manifest.files[path]!.hash, bytes);
    }
    await this.put("manifests", snapshot.id, JSON.stringify(snapshot.manifest));
  }

  private async put(kind: string, id: string, content: string | Buffer): Promise<void> {
    const path = join(this.directory, kind, objectId(id));
    try {
      const existing = await readFile(path);
      if (!existing.equals(Buffer.from(content))) throw new Error(`不可变存储发生内容冲突：${kind}/${id}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await atomicWrite(path, content);
    }
  }

  async loadSnapshot(id: string): Promise<Snapshot> {
    const raw = await readFile(join(this.directory, "manifests", objectId(id)));
    if (hash(raw) !== id) throw new Error(`文件清单损坏：${id}`);
    const manifest = JSON.parse(raw.toString()) as Manifest;
    if (manifest.version !== 1 || !manifest.files) throw new Error("不支持的文件清单格式。");
    const contents = new Map<string, Buffer>();
    const modes = new Map<string, number>();
    for (const [path, version] of Object.entries(manifest.files)) {
      const bytes = await readFile(join(this.directory, "objects", objectId(version.hash)));
      if (hash(bytes) !== version.hash || bytes.length !== version.bytes) throw new Error(`文件内容对象损坏：${path}`);
      contents.set(path, bytes);
      modes.set(path, version.mode);
    }
    const snapshot = snapshotFrom(contents, modes, this.config);
    if (snapshot.id !== id) throw new Error("文件清单未通过规范化校验。");
    return snapshot;
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const bytes = JSON.stringify(checkpoint);
    await this.put("checkpoints", hash(bytes), bytes);
    const projection = JSON.stringify({ version: 1, omissions: checkpoint.omissions });
    await this.put("projections", hash(projection), projection);
  }

  async verifyCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const expected = JSON.stringify(checkpoint);
    const actual = await readFile(join(this.directory, "checkpoints", hash(expected)), "utf8");
    if (actual !== expected) throw new Error("检查点记录缺失或损坏。");
    await this.loadSnapshot(checkpoint.workingId);
    await this.loadSnapshot(checkpoint.baselineId);
  }

  async journal(transaction: Transaction): Promise<void> {
    if (!/^[\w-]+$/.test(transaction.id)) throw new Error("无效的事务引用。");
    await atomicWrite(join(this.directory, "transactions", `${transaction.id}.json`), JSON.stringify(transaction));
  }

  async pendingTransactions(): Promise<Transaction[]> {
    const directory = join(this.directory, "transactions");
    await mkdir(directory, { recursive: true });
    const pending: Transaction[] = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      const transaction = JSON.parse(await readFile(join(directory, name), "utf8")) as Transaction;
      if (transaction.phase !== "done") pending.push(transaction);
    }
    return pending;
  }

  transaction(sessionId: string, kind: Transaction["kind"], fromId: string, toId: string): Transaction {
    return { version: 1, id: randomUUID(), sessionId, kind, fromId, toId, phase: "prepared" };
  }
}
