import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import type { IdeState } from "../../src/ide-protocol.ts";
import { decoration, formatSelection, inside } from "../src/model.ts";

const root = resolve("/project/docs");
const state: IdeState = { version: 1, instanceId: "instance", sessionId: "session", leafId: null,
  cwd: resolve("/project"), root, mode: "needs-recovery", busy: false, canMount: false,
  files: ["chapter.md", "nested/note.md"], changes: [{ path: "nested/deleted.md", kind: "deleted" }] };

test("decorations reflect actual managed files and pending descendants without leaking into parent or sibling directories", () => {
  assert.equal(decoration(state, root)?.badge, "!");
  assert.equal(decoration(state, resolve(root, "chapter.md"))?.badge, "M");
  assert.equal(decoration(state, resolve(root, "nested"))?.badge, "!");
  assert.equal(decoration(state, resolve(root, "nested/deleted.md"))?.badge, "!");
  assert.equal(decoration(state, resolve(root, "excluded.png")), undefined);
  assert.equal(decoration(state, resolve(root, "..")), undefined);
  assert.equal(decoration(state, resolve(root, "../docs-other/chapter.md")), undefined);
  assert.equal(decoration(undefined, root), undefined);
  assert.equal(inside(root, resolve(root, "../docs-other")), false);
});

test("selection formatting preserves text, disambiguates embedded fences, and identifies unsaved input", () => {
  const text = "段落\n```ts\nconst a = 1;\n```\n";
  const result = formatSelection("docs/提纲.md", 2, 6, text, true);
  // Extract the fenced payload and compare the real selected bytes, not implementation wording.
  const lines = result.split("\n");
  const fenceStart = lines.findIndex((line) => /^`{3,}$/.test(line));
  const fence = lines[fenceStart]!;
  assert(fence.length > 3);
  const end = lines.lastIndexOf(fence);
  assert.equal(lines.slice(fenceStart + 1, end).join("\n"), text);
  assert.notEqual(result, formatSelection("docs/提纲.md", 2, 6, text, false));
});
