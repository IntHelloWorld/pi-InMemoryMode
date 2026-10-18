import { lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { atomicWrite, FileIndex, isMissing, managedPath, safePath, snapshotFrom } from "./files.ts";
import { Ownership } from "./ownership.ts";
import { Store, type Transaction } from "./store.ts";
import { EXTERNAL_CHOICE, externalChangeSummary } from "./external-changes.ts";
import { SerialQueue, type Mode, type MountConfig, type Snapshot } from "./types.ts";

export class Workspace {
  readonly queue = new SerialQueue();
  readonly store: Store;
  readonly ownership = new Ownership();
  private readonly fileIndex: FileIndex;
  mode: Mode = "needs-recovery";
  working!: Snapshot;
  baseline!: Snapshot;
  recoveryBackupId?: string;
  externalSnapshotId?: string;
  failure?: string;
  externalChange = false;
  /** Time of the last explicit/boundary scan, never refreshed by IDE status reads. */
  lastCheckedAt?: number;
  private transactions: Transaction[] = [];
  readonly config: MountConfig;
  readonly sessionId: string;

  constructor(config: MountConfig, sessionId: string) {
    this.config = config;
    this.sessionId = sessionId;
    this.store = new Store(config);
    this.fileIndex = new FileIndex(config);
  }

  async mount(): Promise<string[]> {
    await this.ownership.acquire(this.config.root);
    try {
      const { snapshot, excluded } = await this.fileIndex.scan();
      this.lastCheckedAt = Date.now();
      await this.store.saveSnapshot(snapshot);
      this.working = this.baseline = snapshot;
      const pending = await this.store.pendingTransactions();
      this.mode = pending.length ? "needs-recovery" : "ready";
      if (pending.length) this.failure = `Unfinished file transactions were found.\n\n${EXTERNAL_CHOICE}`;
      return excluded;
    } catch (error) {
      await this.ownership.release();
      throw error;
    }
  }

  assertReady(): void {
    if (this.mode !== "ready") throw new Error(this.failure ?? `The current state is ${this.mode}. Run /inmem recover first.`);
  }

  relative(absolute: string): string | undefined {
    return managedPath(this.config, absolute);
  }

  async disk(): Promise<Snapshot> {
    const snapshot = (await this.fileIndex.scan()).snapshot;
    this.lastCheckedAt = Date.now();
    return snapshot;
  }

  async consistent(): Promise<Snapshot> {
    this.assertReady();
    const disk = await this.disk();
    if (disk.id !== this.working.id) {
      await this.store.saveSnapshot(disk);
      this.recoveryBackupId = disk.id;
      this.externalSnapshotId = disk.id;
      this.mode = "needs-recovery";
      this.externalChange = true;
      this.failure = [
        "External changes detected. Disk contents were backed up but have not been accepted into working memory.",
        externalChangeSummary(this.working, disk),
        EXTERNAL_CHOICE,
      ].join("\n\n");
      throw new Error(this.failure);
    }
    return disk;
  }

  async knownExternalChanges(): Promise<string | undefined> {
    if (!this.externalSnapshotId) return;
    const snapshot = await this.store.loadSnapshot(this.externalSnapshotId);
    return "Results from the last inspection; disk files have not been compared again:\n" + externalChangeSummary(this.working, snapshot);
  }

  candidate(changes: Map<string, Buffer | null>, permissions?: Map<string, number>): Snapshot {
    const contents = new Map(this.working.contents);
    const modes = new Map(Object.entries(this.working.manifest.files).map(([path, file]) => [path, file.mode]));
    for (const [path, bytes] of changes) {
      if (bytes === null) contents.delete(path);
      else contents.set(path, bytes);
    }
    for (const [path, mode] of permissions ?? []) modes.set(path, mode);
    return snapshotFrom(contents, modes, this.config, this.working);
  }

  async commit(changes: Map<string, Buffer | null>, signal?: AbortSignal, permissions?: Map<string, number>): Promise<Snapshot> {
    this.assertReady();
    signal?.throwIfAborted();
    const next = this.candidate(changes, permissions);
    await this.store.saveSnapshot(next);
    const transaction = this.store.transaction(this.sessionId, "write", this.working.id, next.id);
    await this.store.journal(transaction);
    try {
      // Checkpoint 2: one comparison immediately before committing the whole operation.
      await this.consistent();
      signal?.throwIfAborted();
      await this.apply(this.working, next);
      transaction.phase = "files-applied";
      await this.store.journal(transaction);
      this.working = next;
      transaction.phase = "state-committed";
      await this.store.journal(transaction);
      this.transactions.push(transaction);
      return next;
    } catch (error) {
      this.mode = "needs-recovery";
      this.failure ??= `The file commit is incomplete. The recovery journal is preserved.\n\n${EXTERNAL_CHOICE}`;
      throw error;
    }
  }

  /** Called only after a durable session/checkpoint record explains successful mutations. */
  async finishTransactions(): Promise<void> {
    for (const transaction of this.transactions) {
      transaction.phase = "done";
      await this.store.journal(transaction);
    }
    this.transactions = [];
  }

  async validatePaths(from: Snapshot, target: Snapshot): Promise<void> {
    const paths = [...new Set([...Object.keys(from.manifest.files), ...Object.keys(target.manifest.files)])].sort();
    // Check every destination before touching any file. Never follow replacement symlinks.
    for (const path of paths) {
      const absolute = await safePath(this.config.root, path);
      try {
        if (!(await lstat(absolute)).isFile()) throw new Error(`Recovery target is not a regular file: ${path}`);
      } catch (error) { if (!isMissing(error)) throw error; }
    }
  }

  async apply(from: Snapshot, target: Snapshot): Promise<void> {
    await this.validatePaths(from, target);
    const paths = [...new Set([...Object.keys(from.manifest.files), ...Object.keys(target.manifest.files)])].sort().filter((path) => {
      const previous = from.manifest.files[path];
      const next = target.manifest.files[path];
      return previous?.hash !== next?.hash || previous?.mode !== next?.mode;
    });
    this.fileIndex.invalidate(paths);
    for (const path of paths) {
      const next = target.manifest.files[path];
      const absolute = await safePath(this.config.root, path);
      if (!next) {
        await unlink(absolute).catch((error: unknown) => { if (!isMissing(error)) throw error; });
      } else {
        await mkdir(dirname(absolute), { recursive: true });
        await safePath(this.config.root, path);
        await atomicWrite(absolute, target.contents.get(path)!, next.mode);
      }
    }
    // Verify only this operation's destinations; external-change scans belong at the three boundaries.
    await this.fileIndex.verify(paths, target);
  }

  async restore(target: Snapshot, transaction: Transaction): Promise<void> {
    const before = await this.disk();
    await this.store.saveSnapshot(before);
    this.recoveryBackupId = before.id;
    transaction.fromId = before.id;
    await this.store.journal(transaction);
    try {
      await this.apply(before, target);
      transaction.phase = "files-applied";
      await this.store.journal(transaction);
      this.working = target;
    } catch (error) {
      try { await this.apply(await this.disk(), before); }
      catch { /* Both immutable versions and the journal remain for explicit recovery. */ }
      this.mode = "needs-recovery";
      this.failure = "Recovery is incomplete. The departure state and target version are saved. Run /inmem recover.";
      throw error;
    }
  }

  async recover(fromDisk: boolean): Promise<void> {
    const disk = await this.disk();
    await this.store.saveSnapshot(disk);
    this.recoveryBackupId = disk.id;
    const target = fromDisk ? disk : this.working;
    const transaction = this.store.transaction(this.sessionId, "recovery", disk.id, target.id);
    await this.store.journal(transaction);
    if (!fromDisk) await this.restore(target, transaction);
    this.working = this.baseline = target;
    this.mode = "ready";
    this.failure = undefined;
    this.externalChange = false;
    this.externalSnapshotId = undefined;
    // Mark older interrupted transactions done only after the recovery checkpoint is published.
    this.transactions = [...await this.store.pendingTransactions()];
  }

  async read(absolute: string): Promise<Buffer> {
    const path = this.relative(resolve(absolute));
    if (!path) throw new Error("The file is outside the managed scope.");
    await safePath(this.config.root, path);
    const content = this.working.contents.get(path);
    if (!content) throw new Error(`File does not exist: ${path}`);
    return Buffer.from(content);
  }
}
