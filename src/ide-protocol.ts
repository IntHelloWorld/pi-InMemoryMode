/** Shared by the Pi package and the independently bundled VS Code extension. */
export const IDE_PROTOCOL_VERSION = 1;
export const IDE_MAX_REQUEST_BYTES = 512 * 1024;

export interface IdeConnection {
  version: 1;
  instanceId: string;
  pid: number;
  port: number;
  token: string;
  cwd: string;
  terminalId?: string;
}

export interface IdeChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  permissionsChanged?: boolean;
}

export interface IdeState {
  version: 1;
  instanceId: string;
  sessionId: string;
  sessionName?: string;
  leafId: string | null;
  cwd: string;
  root?: string;
  mode: "ordinary" | "ready" | "switching" | "needs-recovery";
  busy: boolean;
  canMount: boolean;
  files: string[];
  changes: IdeChange[];
  checkedAt?: number;
  workingId?: string;
  externalSnapshotId?: string;
  reason?: string;
}

export type IdeAction =
  | { type: "mount"; directory: string }
  | { type: "check" }
  | { type: "sync" | "recover"; workingId: string; externalSnapshotId?: string }
  | { type: "selection"; text: string; destination: "draft" | "send" }
  | { type: "diff"; path: string; workingId: string; externalSnapshotId: string }
  | { type: "diffs"; workingId: string; externalSnapshotId: string };

export interface IdeRequest {
  id: string;
  sessionId: string;
  leafId: string | null;
  action: IdeAction;
}

export interface IdeDiff {
  path: string;
  before: string;
  after: string;
  beforeExists: boolean;
  afterExists: boolean;
  beforeMode?: number;
  afterMode?: number;
}

export interface IdeResult {
  message: string;
  disposition?: "submitted" | "draft";
  diff?: IdeDiff;
  diffs?: IdeDiff[];
}

export function isIdeConnection(value: unknown): value is IdeConnection {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && typeof v.instanceId === "string" && /^[\w-]{1,80}$/.test(v.instanceId) &&
    Number.isSafeInteger(v.pid) && Number(v.pid) > 0 && Number.isSafeInteger(v.port) && Number(v.port) > 0 && Number(v.port) < 65536 &&
    typeof v.token === "string" && v.token.length >= 32 && typeof v.cwd === "string" &&
    (v.terminalId === undefined || typeof v.terminalId === "string");
}

export function isIdeRequest(value: unknown): value is IdeRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !/^[\w-]{1,80}$/.test(v.id) || typeof v.sessionId !== "string" ||
    !(v.leafId === null || typeof v.leafId === "string") || !v.action || typeof v.action !== "object") return false;
  const a = v.action as Record<string, unknown>;
  const snapshotId = (id: unknown) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
  switch (a.type) {
    case "mount": return typeof a.directory === "string" && !!a.directory.trim() && !/[\r\n\0]/.test(a.directory);
    case "check": return true;
    case "sync": case "recover": return snapshotId(a.workingId) && (a.externalSnapshotId === undefined || snapshotId(a.externalSnapshotId));
    case "selection": return typeof a.text === "string" && !!a.text.trim() && (a.destination === "draft" || a.destination === "send");
    case "diff": return typeof a.path === "string" && snapshotId(a.workingId) && snapshotId(a.externalSnapshotId);
    case "diffs": return snapshotId(a.workingId) && snapshotId(a.externalSnapshotId);
    default: return false;
  }
}
