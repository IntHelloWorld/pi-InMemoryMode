import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIdeConnection, type IdeAction, type IdeConnection, type IdeRequest, type IdeResult, type IdeState } from "../../src/ide-protocol.ts";

export function registryDirectory(): string {
  return process.env.PI_INMEMORY_IDE_DIR ?? join(tmpdir(), `pi-inmemory-ide-${process.getuid?.() ?? "user"}`);
}

export async function discover(directory = registryDirectory()): Promise<IdeConnection[]> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const results = await Promise.all(names.filter((name) => /^[\w-]+\.json$/.test(name)).map(async (name) => {
    try {
      const connection: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (!isIdeConnection(connection)) return;
      try { process.kill(connection.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return; }
      return connection;
    } catch { return; }
  }));
  return results.filter((connection): connection is IdeConnection => !!connection);
}

export function exchange<T>(connection: IdeConnection, method: "GET" | "POST", path: string, data?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = request({ host: "127.0.0.1", port: connection.port, method, path,
      headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { res.destroy(new Error("The Pi response is too large.")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) reject(new Error(value.error ?? `Pi returned status ${res.statusCode}`));
          else resolve(value as T);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("The Pi connection timed out. Check the terminal and refresh connections.")));
    req.on("error", reject);
    req.end(body);
  });
}

export async function readState(connection: IdeConnection): Promise<IdeState> {
  const state = await exchange<IdeState>(connection, "GET", "/state");
  if (state.version !== 1 || state.instanceId !== connection.instanceId || !Array.isArray(state.files) || !Array.isArray(state.changes)) {
    throw new Error("Pi returned an incompatible state. Update both the Pi plugin and the VS Code extension.");
  }
  return state;
}

export function perform(connection: IdeConnection, state: IdeState, action: IdeAction): Promise<IdeResult> {
  const operation: IdeRequest = { id: randomUUID(), sessionId: state.sessionId, leafId: state.leafId, action };
  return exchange(connection, "POST", "/command", operation);
}
