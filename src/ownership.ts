import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { atomicWrite, inside, isMissing } from "./files.ts";

interface Owner { root: string; pid: number; token: string }
const REGISTRY = join(tmpdir(), `pi-inmemory-owners-${process.getuid?.() ?? "user"}`);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !!error && typeof error === "object" && "code" in error && error.code === "EPERM"; }
}

async function registry<T>(operation: (owners: Owner[]) => T): Promise<T> {
  await mkdir(REGISTRY, { recursive: true });
  const guard = join(REGISTRY, "guard");
  let locked = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(guard);
      await atomicWrite(join(guard, "pid"), String(process.pid));
      locked = true;
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      try {
        const pid = Number(await readFile(join(guard, "pid"), "utf8"));
        if (pid > 0 && !alive(pid)) await rm(guard, { recursive: true, force: true });
      } catch (readError) {
        if (!isMissing(readError)) throw readError;
        // A process can die between creating the guard directory and writing its PID.
        try {
          if (Date.now() - (await stat(guard)).mtimeMs > 1500) await rm(guard, { recursive: true, force: true });
        } catch (statError) { if (!isMissing(statError)) throw statError; }
      }
      await setTimeout(20);
    }
  }
  if (!locked) throw new Error("无法取得工作区所有权锁，请稍后重试。");
  try {
    let owners: Owner[] = [];
    try { owners = JSON.parse(await readFile(join(REGISTRY, "owners.json"), "utf8")); }
    catch (error) { if (!isMissing(error)) throw error; }
    owners = owners.filter((owner) => alive(owner.pid));
    const result = operation(owners);
    await atomicWrite(join(REGISTRY, "owners.json"), JSON.stringify(owners));
    return result;
  } finally { await rm(guard, { recursive: true, force: true }); }
}

export class Ownership {
  private readonly token = randomUUID();

  async acquire(root: string): Promise<void> {
    await registry((owners) => {
      const conflict = owners.find((owner) => owner.token !== this.token && (inside(root, owner.root) || inside(owner.root, root)));
      if (conflict) throw new Error(`目录已被另一个写入会话占用（进程 ${conflict.pid}）：${conflict.root}`);
      const own = owners.find((owner) => owner.token === this.token);
      if (own) own.root = root;
      else owners.push({ root, pid: process.pid, token: this.token });
    });
  }

  async release(): Promise<void> {
    await registry((owners) => {
      const index = owners.findIndex((owner) => owner.token === this.token);
      if (index !== -1) owners.splice(index, 1);
    });
  }
}
