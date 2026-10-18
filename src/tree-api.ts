import type { ExtensionContext, SessionInfo, SessionTreeNode } from "@earendil-works/pi-coding-agent";

export interface SessionListEvent {
  type: "session_list";
  sessions: Array<SessionInfo & { displayBadge?: string }>;
  signal?: AbortSignal;
}

/** Display-only hooks provided by scripts/setup-tree-host.mjs for Pi 1.3.0. */
export interface SessionTreeOpenEvent {
  type: "session_tree_open";
  tree: SessionTreeNode[];
  currentLeafId: string | null;
  initialFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
  skipSummaryPrompt: boolean;
  cancel?: boolean;
}

declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionAPI {
    on(event: "session_list", handler: (event: SessionListEvent, ctx: ExtensionContext) => void | Promise<void>): () => void;
    on(event: "session_tree_open", handler: (event: SessionTreeOpenEvent, ctx: ExtensionContext) => void | Promise<void>): () => void;
  }
  interface ExtensionRunner {
    emit(event: SessionListEvent): Promise<void>;
    emit(event: SessionTreeOpenEvent): Promise<void>;
  }
}
