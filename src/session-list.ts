import { readFile, stat } from "node:fs/promises";
import { parseSessionEntries, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { checkpointEntry } from "./projection.ts";
import type { SessionListEvent } from "./tree-api.ts";

export type SessionType = "ordinary" | "inmemory";

/** Category belongs to the whole session, including legacy disabled routes. */
export function sessionType(entries: SessionEntry[]): SessionType {
  return entries.some(checkpointEntry) ? "inmemory" : "ordinary";
}

export class SessionList {
  private cache = new Map<string, { signature: string; type: SessionType }>();

  private async fromFile(path: string, sessionId: string, signal?: AbortSignal): Promise<SessionType> {
    const metadata = await stat(path);
    const signature = `${sessionId}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
    const cached = this.cache.get(path);
    if (cached?.signature === signature) return cached.type;
    // Parsing is read-only: opening a SessionManager could migrate or rewrite old files.
    const entries = parseSessionEntries(await readFile(path, { encoding: "utf8", signal }))
      .filter((entry): entry is SessionEntry => entry.type !== "session");
    const type = sessionType(entries);
    if (this.cache.size >= 512) this.cache.clear();
    this.cache.set(path, { signature, type });
    return type;
  }

  async decorate(event: SessionListEvent, ctx: ExtensionContext): Promise<void> {
    const current = ctx.sessionManager;
    let next = 0;
    // Bound file reads when /resume includes many sessions or all projects.
    await Promise.all(Array.from({ length: Math.min(4, event.sessions.length) }, async () => {
      while (next < event.sessions.length) {
        if (event.signal?.aborted) return;
        const info = event.sessions[next++]!;
        try {
          const type = info.path === current.getSessionFile()
            ? sessionType(current.getEntries())
            : await this.fromFile(info.path, info.id, event.signal);
          if (type === "inmemory") info.displayBadge = "[InMemory]";
        } catch {
          if (event.signal?.aborted) return;
          // A disappearing/unreadable session must not prevent the rest from loading.
        }
      }
    }));
  }
}
