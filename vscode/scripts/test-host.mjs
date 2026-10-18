import { mkdtemp, mkdir, rm, access, realpath, symlink, readdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';

const extensionPath = resolve(import.meta.dirname, '..');
const repo = resolve(extensionPath, '..');
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'pi-vscode-host-')));
const workspace = join(temporary, 'workspace');
await mkdir(workspace);
await mkdir(join(temporary, 'registry'));
const terminalBin = join(temporary, 'bin');
await mkdir(terminalBin);
await symlink(process.env.PI_IDE_TEST_PI ?? join(repo, 'node_modules/.bin/pi'), join(terminalBin, 'pi'));
await symlink(process.execPath, join(terminalBin, 'node'));
const env = { PI_INMEMORY_IDE_DIR: join(temporary, 'registry'), PI_IDE_TEST_WORKSPACE: workspace,
  PI_IDE_TEST_REPO: repo, PI_IDE_TEST_PI: join(terminalBin, 'pi'), PI_CODING_AGENT_DIR: join(temporary, 'agent') };
await build({ entryPoints: [join(extensionPath, 'tests/host.ts')], outfile: join(extensionPath, 'dist/test.cjs'),
  platform: 'node', format: 'cjs', bundle: true, external: ['vscode'] });
const fixture = spawn(process.execPath, [join(extensionPath, 'tests/pi-fixture.ts')], { cwd: repo,
  env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });

async function outputFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await outputFiles(path));
    else if (entry.name.includes('Pi InMemory') && entry.name.endsWith('.log')) paths.push(path);
  }
  return paths;
}

try {
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Pi fixture startup timed out')), 20000);
    let output = '';
    fixture.stdout.on('data', (chunk) => { output += chunk; if (output.includes('IDE_FIXTURE_READY')) { clearTimeout(timeout); resolveReady(); } });
    fixture.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Pi fixture exited: ${code}`)); });
  });
  let executable = process.env.VSCODE_EXECUTABLE;
  const macExecutable = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  if (!executable && process.platform === 'darwin') { try { await access(macExecutable); executable = macExecutable; } catch {} }
  await runTests({ ...(executable ? { vscodeExecutablePath: executable } : {}),
    extensionDevelopmentPath: extensionPath, extensionTestsPath: join(extensionPath, 'dist/test.cjs'),
    extensionTestsEnv: { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    launchArgs: [workspace, '--user-data-dir', join(temporary, 'user'), '--extensions-dir', join(temporary, 'extensions'),
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-gpu',
      '--disable-extension', 'github.copilot-chat'] });
  const files = await outputFiles(join(temporary, 'user', 'logs'));
  assert(files.length > 0, 'Pi InMemory Output channel must create a real log file');
  const logs = (await Promise.all(files.map(path => readFile(path, 'utf8')))).join('\n');
  assert(logs.length > 0);
  assert(!logs.includes('Authorization') && !logs.includes('Bearer '), 'Output must not contain connection credentials');
  assert(!logs.includes('Selection from VS Code'), 'Output must not contain selection payloads');
  console.log('Pi InMemory Output: runtime log file verified, without credentials or selection payloads.');
} catch (error) {
  // Keep actionable extension diagnostics visible even though the isolated profile is removed.
  for (const path of await outputFiles(join(temporary, 'user', 'logs'))) console.error(await readFile(path, 'utf8'));
  throw error;
} finally {
  if (fixture.exitCode === null) {
    const exited = once(fixture, 'exit');
    fixture.stdin.end('close\n');
    const timeout = setTimeout(() => fixture.kill(), 5000);
    await exited;
    clearTimeout(timeout);
  }
  await rm(temporary, { recursive: true, force: true });
}
