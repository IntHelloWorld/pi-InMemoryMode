import { isAbsolute, relative, resolve, sep } from "node:path";
import type { IdeState } from "../../src/ide-protocol.ts";

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function decoration(state: IdeState | undefined, absolute: string): { badge: string; tooltip: string; pending: boolean } | undefined {
  if (!state?.root || !inside(state.root, absolute)) return;
  const path = relative(state.root, absolute);
  const pending = state.changes.some((change) => change.path === path || inside(absolute, resolve(state.root!, change.path)));
  const managed = path === "" || state.files.includes(path) || state.files.some((file) => inside(absolute, resolve(state.root!, file)));
  if (!managed && !pending) return;
  return { badge: pending ? "!" : "M", pending,
    tooltip: `${pending ? "External changes pending" : "Managed by Pi"}\n${state.sessionName ?? state.sessionId}\n${state.root}` };
}

export function formatSelection(path: string, startLine: number, endLine: number, text: string, dirty: boolean): string {
  // Match the delimiter length to the content, so selected Markdown remains unambiguous.
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `Selection from VS Code\nFile: ${JSON.stringify(path)}\nLines: ${startLine}–${endLine}${dirty ? "\nStatus: Includes unsaved changes. The file has not been saved automatically." : ""}\n${fence}\n${text}\n${fence}`;
}
