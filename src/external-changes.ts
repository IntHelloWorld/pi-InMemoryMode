import type { Snapshot } from "./types.ts";

export const EXTERNAL_CHANGE_TYPE = "inmemory.external-change";
export const EXTERNAL_CHOICE = [
  "请选择一种处理方式：",
  "  • /memory sync：接纳外部修改，并记录修改消息。",
  "  • /memory recover：撤销外部修改，保留助手已成功的修改。",
  "",
  "处理后等待新指令。如需撤销助手的修改：",
  "  • /tree：选择要恢复的位置。",
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
  const labels = { added: "新增", modified: "修改", deleted: "删除" };
  const lines = changes.map((change) => {
    let label = labels[change.kind];
    if (change.kind === "modified") {
      const previous = before.manifest.files[change.path]!;
      const next = after.manifest.files[change.path]!;
      if (previous.mode !== next.mode) label = previous.hash === next.hash ? "权限" : "修改及权限";
    }
    return `  • ${label}  ${JSON.stringify(change.path)}`;
  });
  return [`未同步文件（${changes.length} 个，路径相对托管目录）：`, ...lines].join("\n");
}
