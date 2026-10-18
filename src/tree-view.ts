import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { checkpointEntry } from "./projection.ts";

const CHECKPOINT_LABELS: Record<string, string> = {
  mount: "Memory：初始挂载", sync: "Memory：外部同步",
  external: "Memory：外部修改",
};

/** Reconnect visible descendants to their nearest visible ancestor, without editing history. */
export function selectableTree(tree: SessionTreeNode[], allowed: Set<string>): SessionTreeNode[] {
  const roots: SessionTreeNode[] = [];
  const stack = [...tree].reverse().map((node) => ({ node, parent: undefined as SessionTreeNode | undefined }));
  while (stack.length) {
    const { node, parent } = stack.pop()!;
    let visibleParent = parent;
    if (allowed.has(node.entry.id)) {
      const visible: SessionTreeNode = {
        ...node,
        label: node.label ?? (checkpointEntry(node.entry) ? CHECKPOINT_LABELS[node.entry.data!.kind] : undefined),
        entry: { ...node.entry, parentId: parent?.entry.id ?? null },
        children: [],
      };
      (parent?.children ?? roots).push(visible);
      visibleParent = visible;
    }
    for (const child of [...node.children].reverse()) stack.push({ node: child, parent: visibleParent });
  }
  return roots;
}

export function visibleLeaf(entries: SessionEntry[], leafId: string | null, allowed: Set<string>): string | null {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const visited = new Set<string>();
  let current = leafId;
  while (current && !visited.has(current)) {
    if (allowed.has(current)) return current;
    visited.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return null;
}
