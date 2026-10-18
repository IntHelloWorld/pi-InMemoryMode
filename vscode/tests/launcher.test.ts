import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { prepareLaunch } from "../src/launcher.ts";

test("Pi's actual env-node shebang launches with GUI PATH when Node is installed alongside Pi", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-launch-"));
  try {
    const pi = join(directory, "pi");
    await writeFile(pi, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n', { mode: 0o755 });
    await symlink(process.execPath, join(directory, "node"));
    const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
    const runtime = await prepareLaunch(pi, "", env);
    const args = ["-e", "/test/plugin path/插件"];
    const result = spawnSync(runtime.executable, args, { env: { ...env, PATH: runtime.path }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
    assert.equal(dirname(runtime.node), directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an explicit Node path works outside Pi's directory and a missing configured runtime fails before launching", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-node-"));
  try {
    const pi = join(directory, "pi");
    await writeFile(pi, "#!/usr/bin/env node\n", { mode: 0o755 });
    const nodeDirectory = join(directory, "runtime");
    await mkdir(nodeDirectory);
    const node = join(nodeDirectory, "node");
    await symlink(process.execPath, node);
    const runtime = await prepareLaunch(pi, node, { PATH: "/usr/bin:/bin" });
    const result = spawnSync(runtime.node, ["--version"], { env: { PATH: runtime.path }, encoding: "utf8" });
    assert.equal(result.status, 0);
    await assert.rejects(prepareLaunch(pi, join(directory, "missing-node")));
    await assert.rejects(prepareLaunch(join(directory, "missing-pi")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
