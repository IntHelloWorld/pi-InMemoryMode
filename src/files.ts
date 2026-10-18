import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileVersion, Manifest, MountConfig, Snapshot } from "./types.ts";

const EXCLUDED_DIRECTORIES = new Set([".git", ".pi", "node_modules", "vendor", "dist", "build", "coverage", ".next", ".venv"]);
const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|(?:credentials?|secrets?|auth|accounts?)(?:\.[^/]*)?)$/i;
const DEFAULTS = {
  extensions: [".md", ".txt", ".json", ".yaml", ".yml", ".toml"],
  exclude: [] as string[],
  includeHidden: false,
  maxFiles: 100,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxSnapshotTokens: 32768,
};

export function hash(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function resolvePath(cwd: string, path: string): string {
  let normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  const expanded = normalized === "~" ? homedir() : normalized.startsWith("~/") ? join(homedir(), normalized.slice(2)) : normalized;
  return resolve(cwd, expanded.startsWith("file://") ? fileURLToPath(expanded) : expanded);
}

export async function mountConfig(cwd: string, directory: string): Promise<MountConfig> {
  const canonicalCwd = await realpath(cwd);
  const root = await realpath(resolvePath(canonicalCwd, directory));
  if (!(await lstat(root)).isDirectory()) throw new Error("挂载路径必须是目录。");
  let overrides: Record<string, unknown> = {};
  try {
    overrides = JSON.parse(await readFile(join(canonicalCwd, ".pi/inmemory.json"), "utf8"));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (!overrides || Array.isArray(overrides) || typeof overrides !== "object") throw new Error("inmemory.json 必须是配置对象。");
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULTS)) throw new Error(`未知配置项：${key}`);
  }
  const config = { ...DEFAULTS, ...overrides, cwd: canonicalCwd, root } as MountConfig;
  for (const key of ["maxFiles", "maxFileBytes", "maxTotalBytes", "maxSnapshotTokens"] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${key} 必须是正整数。`);
  }
  if (typeof config.includeHidden !== "boolean") throw new Error("includeHidden 必须是布尔值。");
  if (!Array.isArray(config.extensions) || !config.extensions.every((item) => typeof item === "string" && /^\.[\w-]+$/.test(item))) {
    throw new Error("extensions 必须是文件扩展名数组，如 [\".md\", \".txt\"]。");
  }
  config.extensions = [...new Set(config.extensions.map((item) => item.toLowerCase()))].sort();
  if (!Array.isArray(config.exclude) || !config.exclude.every((item) => typeof item === "string" && item.length > 0 && !item.includes("..") && !isAbsolute(item))) {
    throw new Error("exclude 必须是相对路径前缀数组。");
  }
  return config;
}

export function excludedReason(config: MountConfig, rel: string): string | undefined {
  const parts = rel.split(sep);
  if (parts.some((part) => EXCLUDED_DIRECTORIES.has(part))) return "管理目录或依赖、构建产物";
  if (parts.some((part) => SENSITIVE_NAME.test(part))) return "账户或敏感配置";
  if (!config.includeHidden && parts.some((part) => part.startsWith("."))) return "隐藏路径";
  if (config.exclude.some((prefix) => rel === prefix || rel.startsWith(`${prefix.replace(/\/$/, "")}${sep}`))) return "显式排除规则";
  return undefined;
}

export function managedPath(config: MountConfig, absolute: string): string | undefined {
  if (!inside(config.root, absolute) || absolute === config.root) return undefined;
  const rel = relative(config.root, absolute);
  return !excludedReason(config, rel) && config.extensions.includes(extname(rel).toLowerCase()) ? rel : undefined;
}

export function validateRelative(path: string): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`不安全的文件路径：${path}`);
  }
}

/** Reject symlinks in every component, including ancestors of the mounted root. */
export async function safePath(root: string, rel: string): Promise<string> {
  validateRelative(rel);
  const absolute = resolve(root, rel);
  if (!inside(root, absolute)) throw new Error(`文件越出托管目录：${rel}`);
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`不支持符号链接：${current}`);
      if (current !== absolute && !info.isDirectory()) throw new Error(`父路径不是目录：${current}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return absolute;
}

export function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export function validateText(bytes: Buffer, name: string): void {
  if (bytes.includes(0)) throw new Error(`不支持含 NUL 字节的文件：${name}`);
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`文件不是有效 UTF-8：${name}`); }
}

function assembleSnapshot(contents: Map<string, Buffer>, versions: Map<string, FileVersion>, config: MountConfig): Snapshot {
  if (contents.size > config.maxFiles) throw new Error(`文件数超出上限 ${config.maxFiles}。`);
  const files: Manifest["files"] = Object.create(null);
  let total = 0;
  for (const path of [...contents.keys()].sort()) {
    const file = versions.get(path)!;
    if (file.bytes > config.maxFileBytes) throw new Error(`文件 ${path} 超出单文件上限 ${config.maxFileBytes} 字节。`);
    total += file.bytes;
    files[path] = file;
  }
  if (total > config.maxTotalBytes) throw new Error(`正文总量超出上限 ${config.maxTotalBytes} 字节。`);
  const manifest: Manifest = { version: 1, files };
  return { id: hash(JSON.stringify(manifest)), manifest, contents: new Map(contents) };
}

/** Reuse versions only for the same immutable in-memory buffers, never from disk metadata. */
export function snapshotFrom(contents: Map<string, Buffer>, modes: Map<string, number>, config: MountConfig, previous?: Snapshot): Snapshot {
  if (contents.size > config.maxFiles) throw new Error(`文件数超出上限 ${config.maxFiles}。`);
  const versions = new Map<string, FileVersion>();
  for (const [path, bytes] of contents) {
    validateRelative(path);
    if (managedPath(config, resolve(config.root, path)) !== path) throw new Error(`路径不符合托管规则：${path}`);
    if (bytes.length > config.maxFileBytes) throw new Error(`文件 ${path} 超出单文件上限 ${config.maxFileBytes} 字节。`);
    const mode = (modes.get(path) ?? 0o644) & 0o777;
    const cached = previous?.contents.get(path) === bytes ? previous.manifest.files[path] : undefined;
    if (!cached) validateText(bytes, path);
    versions.set(path, cached?.mode === mode ? cached : { hash: cached?.hash ?? hash(bytes), bytes: bytes.length, mode });
  }
  return assembleSnapshot(contents, versions, config);
}

interface IndexedFile {
  info: BigIntStats;
  verifiedAt: bigint;
  bytes: Buffer;
  version: FileVersion;
}

export interface ScanStats {
  readFiles: number;
  reusedFiles: number;
  bytesRead: number;
}

function sameFileInfo(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.uid === b.uid && a.gid === b.gid;
}

function racilyClean(file: IndexedFile): boolean {
  // Keep the original verification time when reusing an entry. A fresh read in a
  // later second is required to clear uncertainty on coarse-timestamp filesystems.
  const second = 1_000_000_000n;
  return file.info.mtimeNs / second >= file.verifiedAt / second || file.info.ctimeNs / second >= file.verifiedAt / second;
}

/** Rebuildable, process-local disk cache; it never changes the accepted working snapshot. */
export class FileIndex {
  private entries = new Map<string, IndexedFile>();
  private readonly now: () => number;
  readonly config: MountConfig;

  constructor(config: MountConfig, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
  }

  invalidate(paths: Iterable<string>): void {
    for (const path of paths) this.entries.delete(path);
  }

  private async read(path: string, stats?: ScanStats, force = false): Promise<IndexedFile> {
    const absolute = await safePath(this.config.root, path);
    const verifiedAt = BigInt(this.now()) * 1_000_000n;
    const info = await lstat(absolute, { bigint: true });
    if (!info.isFile()) throw new Error(`托管路径不是普通文件：${path}`);
    if (info.size > BigInt(this.config.maxFileBytes)) throw new Error(`文件 ${path} 超出单文件上限。`);
    const cached = this.entries.get(path);
    if (!force && cached && sameFileInfo(info, cached.info) && !racilyClean(cached)) {
      if (stats) stats.reusedFiles++;
      return cached;
    }

    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const before = await handle.stat({ bigint: true });
      if (!sameFileInfo(info, before)) throw new Error(`读取期间文件发生变化，请重试：${path}`);
      bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      const current = await lstat(absolute, { bigint: true });
      if (!sameFileInfo(before, after) || !sameFileInfo(after, current) || BigInt(bytes.length) !== after.size) {
        throw new Error(`读取期间文件发生变化，请重试：${path}`);
      }
    } finally { await handle.close(); }
    if (stats) { stats.readFiles++; stats.bytesRead += bytes.length; }
    const mode = Number(info.mode & 0o777n);
    if (cached?.bytes.equals(bytes)) {
      return { info, verifiedAt, bytes: cached.bytes,
        version: cached.version.mode === mode ? cached.version : { ...cached.version, mode } };
    }
    validateText(bytes, path);
    return { info, verifiedAt, bytes, version: { hash: hash(bytes), bytes: bytes.length, mode } };
  }

  async scan(): Promise<{ snapshot: Snapshot; excluded: string[]; stats: ScanStats }> {
    const config = this.config;
    if (await realpath(config.root) !== config.root) throw new Error("挂载目录的真实路径发生变化，请重新绑定。");
    const entries = new Map<string, IndexedFile>();
    const contents = new Map<string, Buffer>();
    const versions = new Map<string, FileVersion>();
    const excluded: string[] = [];
    const stats: ScanStats = { readFiles: 0, reusedFiles: 0, bytesRead: 0 };
    let totalBytes = 0;
    const visit = async (dir: string): Promise<void> => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = join(dir, entry.name);
        const rel = relative(config.root, absolute);
        const reason = excludedReason(config, rel);
        if (reason) { excluded.push(`${rel}：${reason}`); continue; }
        if (entry.isSymbolicLink()) { excluded.push(`${rel}：符号链接`); continue; }
        if (entry.isDirectory()) { await safePath(config.root, rel); await visit(absolute); continue; }
        if (!entry.isFile() || !managedPath(config, absolute)) { excluded.push(`${rel}：非托管文本类型`); continue; }
        // Count before reading the next file, including when the cache is warm.
        if (contents.size >= config.maxFiles) throw new Error(`文件数超出上限 ${config.maxFiles}。`);
        const file = await this.read(rel, stats);
        entries.set(rel, file);
        contents.set(rel, file.bytes);
        versions.set(rel, file.version);
        totalBytes += file.bytes.length;
        if (totalBytes > config.maxTotalBytes) throw new Error(`正文总量超出上限 ${config.maxTotalBytes} 字节。`);
      }
    };
    await visit(config.root);
    const snapshot = assembleSnapshot(contents, versions, config);
    // Publish only a complete, validated scan. Removed paths disappear from the cache.
    this.entries = entries;
    return { snapshot, excluded, stats };
  }

  /** Verify only mutation destinations and cache the bytes actually read back. */
  async verify(paths: Iterable<string>, target: Snapshot): Promise<void> {
    for (const path of paths) {
      const expected = target.manifest.files[path];
      if (!expected) {
        const absolute = await safePath(this.config.root, path);
        try { await lstat(absolute); }
        catch (error) { if (isMissing(error)) { this.entries.delete(path); continue; } throw error; }
        throw new Error(`写入后校验失败：${path}`);
      }
      const actual = await this.read(path, undefined, true);
      if (actual.version.hash !== expected.hash || actual.version.mode !== expected.mode) throw new Error(`写入后校验失败：${path}`);
      this.entries.set(path, actual);
    }
  }
}

export async function scan(config: MountConfig): Promise<{ snapshot: Snapshot; excluded: string[]; stats: ScanStats }> {
  return new FileIndex(config).scan();
}

/** Same-directory replacement, flushed before rename; multi-file work uses a journal. */
export async function atomicWrite(path: string, bytes: string | Buffer, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.inmemory-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", mode);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  finally { await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; }); }
}
