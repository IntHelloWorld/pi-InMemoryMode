import type { Snapshot } from "./types.ts";

export const EXTERNAL_CHANGE_TYPE = "inmemory.external-change";
export const EXTERNAL_CHOICE = [
  "Choose how to handle the changes:",
  "  • /inmem sync: Accept external changes and record a change message.",
  "  • /inmem recover: Discard external changes and keep successful assistant edits.",
  "",
  "Afterwards, wait for a new instruction. To undo assistant edits:",
  "  • /tree: Select a recovery point.",
].join("\n");

export interface FileChange {
  path: string;
  kind: "added" | "modified" | "deleted";
}

export function fileChanges(before: Snapshot | undefined, after: Snapshot): FileChange[] {
  const paths = new Set([...Object.keys(before?.manifest.files ?? {}), ...Object.keys(after.manifest.files)]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const previous = before?.manifest.files[path];
    const next = after.manifest.files[path];
    if (!previous) changes.push({ path, kind: "added" });
    else if (!next) changes.push({ path, kind: "deleted" });
    else if (previous.hash !== next.hash || previous.mode !== next.mode) changes.push({ path, kind: "modified" });
  }
  return changes;
}

export function externalChangeSummary(before: Snapshot, after: Snapshot): string {
  const changes = fileChanges(before, after);
  const labels = { added: "Added", modified: "Modified", deleted: "Deleted" };
  const lines = changes.map((change) => {
    let label = labels[change.kind];
    if (change.kind === "modified") {
      const previous = before.manifest.files[change.path]!;
      const next = after.manifest.files[change.path]!;
      if (previous.mode !== next.mode) label = previous.hash === next.hash ? "Permissions" : "Content and permissions";
    }
    return `  • ${label}  ${JSON.stringify(change.path)}`;
  });
  return [`Pending files (${changes.length}; paths relative to the managed directory):`, ...lines].join("\n");
}
