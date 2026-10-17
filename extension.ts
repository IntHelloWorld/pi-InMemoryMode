import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function plugin(pi: ExtensionAPI): void {
  pi.registerCommand("plugin-dev", {
    description: "Check that the local plugin is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("pi-inmemory-mode: development environment ready", "info");
    },
  });
}
