import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mountConfig, scan } from "../src/files.ts";
import { Ownership } from "../src/ownership.ts";
import { Store } from "../src/store.ts";
import { Workspace } from "../src/workspace.ts";

async function directory() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-memory-files-")));
  await mkdir(join(cwd, "docs"));
  return cwd;
}

test("immutable objects deduplicate identical bytes and detect corrupt manifests and contents", async () => {
  const cwd = await directory();
  try {
    await writeFile(join(cwd, "docs/a.md"), "\uFEFFa\r\n");
    await writeFile(join(cwd, "docs/b.md"), "\uFEFFa\r\n");
    await writeFile(join(cwd, "docs/empty.txt"), "");
    await chmod(join(cwd, "docs/a.md"), 0o640);
    const config = await mountConfig(cwd, "docs");
    const { snapshot } = await scan(config);
    const store = new Store(config);
    await store.saveSnapshot(snapshot);
    await store.saveSnapshot(snapshot);
    assert.equal((await readdir(join(store.directory, "objects"))).length, 2);
    const loaded = await store.loadSnapshot(snapshot.id);
    assert.equal(loaded.contents.get("a.md")!.toString(), "\uFEFFa\r\n");
    assert.equal(loaded.manifest.files["a.md"]!.mode, 0o640);
    await writeFile(join(store.directory, "objects", snapshot.manifest.files["a.md"]!.hash), "broken");
    await assert.rejects(store.loadSnapshot(snapshot.id));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("scan excludes management, dependencies, hidden files, credentials and symlinks", async () => {
  const cwd = await directory();
  try {
    await writeFile(join(cwd, "docs/a.md"), "text");
    await writeFile(join(cwd, "docs/credentials.json"), "secret");
    await writeFile(join(cwd, "docs/.hidden.md"), "hidden");
    await writeFile(join(cwd, "docs/image.png"), Buffer.from([0, 255]));
    await mkdir(join(cwd, "docs/.pi"));
    await writeFile(join(cwd, "docs/.pi/state.md"), "state");
    await symlink(join(cwd, "docs/a.md"), join(cwd, "docs/link.md"));
    const result = await scan(await mountConfig(cwd, "docs"));
    assert.deepEqual(Object.keys(result.snapshot.manifest.files), ["a.md"]);
    assert.equal(result.excluded.length, 5);
    await writeFile(join(cwd, "docs/bad.md"), Buffer.from([0xff]));
    await assert.rejects(scan(await mountConfig(cwd, "docs")));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("failed multi-file commit pauses writes and recovers every file from the checkpoint", async () => {
  const cwd = await directory();
  const workspace = new Workspace(await mountConfig(cwd, "docs"), "session");
  try {
    await writeFile(join(cwd, "docs/a.md"), "A");
    await writeFile(join(cwd, "docs/b.md"), "B");
    await workspace.mount();
    const original = workspace.working.id;
    const apply = workspace.apply.bind(workspace);
    workspace.apply = async () => {
      await writeFile(join(cwd, "docs/a.md"), "partial");
      throw new Error("simulated disk failure after first file");
    };
    await assert.rejects(workspace.queue.run(() => workspace.commit(new Map([["a.md", Buffer.from("new A")], ["b.md", null]]))));
    assert.equal(workspace.mode, "needs-recovery");
    assert.equal(workspace.working.id, original);
    assert.equal((await workspace.store.pendingTransactions()).length, 1);
    workspace.apply = apply;
    await workspace.recover(false);
    await workspace.finishTransactions();
    assert.equal(await readFile(join(cwd, "docs/a.md"), "utf8"), "A");
    assert.equal(await readFile(join(cwd, "docs/b.md"), "utf8"), "B");
    assert.equal(workspace.mode, "ready");
    assert.equal((await workspace.store.pendingTransactions()).length, 0);
    assert(workspace.recoveryBackupId);
    assert.equal((await workspace.store.loadSnapshot(workspace.recoveryBackupId)).contents.get("a.md")!.toString(), "partial");
  } finally { await workspace.ownership.release(); await rm(cwd, { recursive: true, force: true }); }
});

test("quota rejection has no filesystem side effects and serial operations retain both changes", async () => {
  const cwd = await directory();
  const config = await mountConfig(cwd, "docs");
  config.maxFileBytes = 8;
  const workspace = new Workspace(config, "session");
  try {
    await workspace.mount();
    await assert.rejects(workspace.queue.run(() => workspace.commit(new Map([["large.md", Buffer.from("123456789")]]))));
    assert.equal(workspace.mode, "ready");
    assert.equal((await workspace.disk()).contents.size, 0);
    await Promise.all([
      workspace.queue.run(() => workspace.commit(new Map([["a.md", Buffer.from("A")]]))),
      workspace.queue.run(() => workspace.commit(new Map([["b.md", Buffer.from("B")]]))),
    ]);
    assert.deepEqual([...workspace.working.contents.keys()], ["a.md", "b.md"]);
    assert.equal((await workspace.disk()).id, workspace.working.id);
  } finally { await workspace.ownership.release(); await rm(cwd, { recursive: true, force: true }); }
});

test("shared writer ownership rejects overlapping mounts and transfers after release", async () => {
  const cwd = await directory();
  const first = new Ownership();
  const second = new Ownership();
  try {
    await first.acquire(join(cwd, "docs"));
    await assert.rejects(second.acquire(cwd));
    await assert.rejects(second.acquire(join(cwd, "docs/nested")));
    await first.release();
    await second.acquire(cwd);
  } finally { await first.release(); await second.release(); await rm(cwd, { recursive: true, force: true }); }
});
