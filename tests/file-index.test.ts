import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, open, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile,
  type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FileIndex, mountConfig, scan } from "../src/files.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext, files: Record<string, string> = { "a.md": "aaaa", "b.md": "bbbb" }) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-file-index-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const root = join(cwd, "docs");
  await mkdir(root);
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  // Make metadata safely older than the verification clock without slow sleeps.
  const clock = { now: Date.now() + 5000 };
  const config = await mountConfig(cwd, "docs");
  return { cwd, root, config, clock, index: new FileIndex(config, () => clock.now) };
}

test("warm scans read no unchanged bodies and reuse their content versions", async (t) => {
  const { root, config, index } = await fixture(t);
  const initial = await index.scan();
  assert.deepEqual(initial.stats, { readFiles: 2, reusedFiles: 0, bytesRead: 8 });
  const unchanged = await index.scan();
  assert.equal(unchanged.snapshot.id, initial.snapshot.id);
  assert.deepEqual(unchanged.stats, { readFiles: 0, reusedFiles: 2, bytesRead: 0 });
  await writeFile(join(root, "a.md"), "changed");
  const changed = await index.scan();
  assert.deepEqual(changed.stats, { readFiles: 1, reusedFiles: 1, bytesRead: 7 });
  assert.equal(changed.snapshot.contents.get("a.md")!.toString(), "changed");
  assert.strictEqual(changed.snapshot.contents.get("b.md"), initial.snapshot.contents.get("b.md"));
  assert.strictEqual(changed.snapshot.manifest.files["b.md"], initial.snapshot.manifest.files["b.md"]);
  assert.equal(changed.snapshot.id, (await scan(config)).snapshot.id);
});

test("touch refreshes metadata without creating a content version or rereading other files", async (t) => {
  const { root, index } = await fixture(t);
  const initial = await index.scan();
  await utimes(join(root, "a.md"), new Date(2000, 0, 1), new Date(2000, 0, 1));
  const touched = await index.scan();
  assert.equal(touched.snapshot.id, initial.snapshot.id);
  assert.deepEqual(touched.stats, { readFiles: 1, reusedFiles: 1, bytesRead: 4 });
  assert.strictEqual(touched.snapshot.manifest.files["a.md"], initial.snapshot.manifest.files["a.md"]);
  assert.deepEqual((await index.scan()).stats, { readFiles: 0, reusedFiles: 2, bytesRead: 0 });
});

test("directory scans find additions, deletions, moves and permissions with a warm cache", async (t) => {
  const { root, config, index } = await fixture(t);
  const initial = (await index.scan()).snapshot;
  await mkdir(join(root, "nested"));
  await rename(join(root, "a.md"), join(root, "nested/moved.md"));
  await rm(join(root, "b.md"));
  await writeFile(join(root, "new.txt"), "new");
  const changed = await index.scan();
  assert.deepEqual(Object.keys(changed.snapshot.manifest.files), ["nested/moved.md", "new.txt"]);
  assert.notEqual(changed.snapshot.id, initial.id);
  await chmod(join(root, "nested/moved.md"), 0o600);
  const permissions = await index.scan();
  assert.equal(permissions.snapshot.manifest.files["nested/moved.md"]!.mode, 0o600);
  assert.equal(permissions.snapshot.manifest.files["nested/moved.md"]!.hash, initial.manifest.files["a.md"]!.hash);
  assert.equal(permissions.stats.readFiles, 1);
  assert.equal(permissions.stats.reusedFiles, 1);
  assert.equal(permissions.snapshot.id, (await scan(config)).snapshot.id);
});

test("same-size edits with restored mtime and atomic replacement cannot reuse stale bytes", async (t) => {
  const { root, index } = await fixture(t);
  const path = join(root, "a.md");
  const original = await stat(path);
  const initial = (await index.scan()).snapshot;
  await writeFile(path, "edit");
  await utimes(path, original.atime, original.mtime);
  const edited = await index.scan();
  assert.equal(edited.snapshot.contents.get("a.md")!.toString(), "edit");
  assert.notEqual(edited.snapshot.id, initial.id);
  await writeFile(join(root, "replacement.tmp"), "save");
  await utimes(join(root, "replacement.tmp"), original.atime, original.mtime);
  await rename(join(root, "replacement.tmp"), path);
  const replaced = await index.scan();
  assert.equal(replaced.snapshot.contents.get("a.md")!.toString(), "save");
  assert.deepEqual(replaced.stats, { readFiles: 1, reusedFiles: 1, bytesRead: 4 });
});

test("recent timestamps require a fresh read in a later second before metadata can be trusted", async (t) => {
  const { root, index, clock } = await fixture(t, { "a.md": "aaaa" });
  const info = await stat(join(root, "a.md"), { bigint: true });
  const timestamp = Number((info.mtimeNs > info.ctimeNs ? info.mtimeNs : info.ctimeNs) / 1_000_000n);
  clock.now = timestamp;
  const initial = await index.scan();
  assert.equal((await index.scan()).stats.readFiles, 1);
  assert.equal((await index.scan()).stats.readFiles, 1);
  clock.now += 2000;
  // Aging the clock alone must not make an uncertain old observation trustworthy.
  assert.equal((await index.scan()).stats.readFiles, 1);
  const stable = await index.scan();
  assert.equal(stable.stats.readFiles, 0);
  assert.equal(stable.snapshot.id, initial.snapshot.id);
});

test("warm caches retain validation and quotas, and failed scans do not hide later changes", async (t) => {
  const { root, config, index } = await fixture(t);
  const initial = (await index.scan()).snapshot;
  config.maxTotalBytes = 7;
  await assert.rejects(index.scan());
  config.maxTotalBytes = 1024;
  config.maxFileBytes = 3;
  await assert.rejects(index.scan());
  config.maxFileBytes = 256;
  config.maxFiles = 1;
  await assert.rejects(index.scan());
  config.maxFiles = 100;
  await writeFile(join(root, "a.md"), Buffer.from([0xff]));
  await assert.rejects(index.scan());
  await writeFile(join(root, "a.md"), "restored");
  const repaired = await index.scan();
  assert.notEqual(repaired.snapshot.id, initial.id);
  assert.equal(repaired.snapshot.contents.get("a.md")!.toString(), "restored");
});

test("a cached file replaced by a symlink is excluded without reading the link target", async (t) => {
  const { cwd, root, index } = await fixture(t);
  await index.scan();
  await writeFile(join(cwd, "outside.txt"), "outside secret");
  await rm(join(root, "a.md"));
  await symlink(join(cwd, "outside.txt"), join(root, "a.md"));
  const result = await index.scan();
  assert.deepEqual(Object.keys(result.snapshot.manifest.files), ["b.md"]);
  assert.deepEqual(result.stats, { readFiles: 0, reusedFiles: 1, bytesRead: 0 });
});

test("replacement while reading rejects the scan instead of caching an obsolete file handle", async (t) => {
  const { root, index } = await fixture(t, { "a.md": "aaaa" });
  const path = join(root, "a.md");
  const handle = await open(path, "r");
  const prototype: Pick<FileHandle, "readFile"> = Object.getPrototypeOf(handle);
  const originalRead = prototype.readFile;
  await handle.close();
  await writeFile(join(root, "replacement.tmp"), "raced");
  const intercepted = t.mock.method(prototype, "readFile", async function (this: FileHandle) {
    const bytes = await originalRead.bind(this)();
    await rename(join(root, "replacement.tmp"), path);
    return bytes;
  });
  await assert.rejects(index.scan());
  intercepted.mock.restore();
  const result = await index.scan();
  assert.equal(result.snapshot.contents.get("a.md")!.toString(), "raced");
  assert.equal(result.stats.readFiles, 1);
});

test("cached disk versions never silently replace accepted working state, and recovery rebuilds the cache", async (t) => {
  const { root, config } = await fixture(t);
  const workspace = new Workspace(config, "file-index-test");
  t.after(() => workspace.ownership.release());
  await workspace.mount();
  const baseline = workspace.baseline;
  await workspace.consistent();
  const candidate = workspace.candidate(new Map([["a.md", Buffer.from("tool")]]));
  assert.strictEqual(candidate.manifest.files["b.md"], baseline.manifest.files["b.md"]);
  await workspace.commit(new Map([["a.md", Buffer.from("tool")]]));
  await workspace.finishTransactions();
  assert.strictEqual(workspace.baseline, baseline);
  await workspace.consistent();
  await writeFile(join(root, "a.md"), "user");
  await assert.rejects(workspace.consistent());
  assert.equal(workspace.working.contents.get("a.md")!.toString(), "tool");
  assert.equal((await workspace.disk()).contents.get("a.md")!.toString(), "user");
  assert.equal(workspace.mode, "needs-recovery");
  await workspace.recover(false);
  await workspace.finishTransactions();
  assert.equal(await readFile(join(root, "a.md"), "utf8"), "tool");
  assert.equal((await workspace.consistent()).id, workspace.working.id);
  await writeFile(join(root, "a.md"), "keep");
  await assert.rejects(workspace.consistent());
  await workspace.recover(true);
  await workspace.finishTransactions();
  assert.equal(workspace.working.contents.get("a.md")!.toString(), "keep");
  assert.equal((await workspace.consistent()).id, workspace.working.id);
});
