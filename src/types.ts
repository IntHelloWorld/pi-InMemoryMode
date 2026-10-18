export interface MountConfig {
  cwd: string;
  root: string;
  extensions: string[];
  exclude: string[];
  includeHidden: boolean;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxSnapshotTokens: number;
}

export interface FileVersion {
  hash: string;
  bytes: number;
  mode: number;
}

export interface Manifest {
  version: 1;
  files: Record<string, FileVersion>;
}

export interface Snapshot {
  id: string;
  manifest: Manifest;
  contents: Map<string, Buffer>;
}

export interface Omission {
  taskId: string;
  entryId: string;
  callId: string;
  tool: "edit" | "write";
  path: string;
  snapshotId: string;
  baselineId: string;
}

export interface TaskState {
  id: string;
  anchorId: string | null;
  afterEntryId: string | null;
  timestamp: number;
  status: "running" | "completed" | "incomplete";
  outcome?: "completed" | "aborted" | "error";
  interruption?: "external-change";
}

export interface Checkpoint {
  version: 1;
  id: string;
  sessionId: string;
  anchorId: string | null;
  config: MountConfig;
  workingId: string;
  baselineId: string;
  task?: TaskState;
  omissions: Omission[];
  /** New checkpoints are always enabled; false is read only for legacy sessions. */
  enabled: boolean;
  /** Keep the user's decision pending even if the disk later matches workingId again. */
  pendingExternal?: boolean;
  /** Last detected disk version; used to restore the file list without scanning current files. */
  externalSnapshotId?: string;
  kind: "mount" | "task-start" | "turn" | "settled" | "interrupted" | "continuation" | "sync" | "external" | "position" | "off" | "recovery" | "compaction";
}

export type Mode = "ready" | "switching" | "needs-recovery";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every workspace operation takes this lock before any Pi per-file mutation queue. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
