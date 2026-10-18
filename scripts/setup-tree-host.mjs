import { constants } from "node:fs";
import { access, copyFile, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "@earendil-works/pi-coding-agent";
const SUPPORTED_VERSION = "1.3.0";
const MARKER = "/* pi-inmemory-tree-hook v1 */";
const LIST_MARKER = "/* pi-inmemory-session-list v1 */";
const BACKUP_SUFFIX = ".inmemory-tree-original";

const sourceStart = `    showTreeSelector(initialSelectedId) {
        const tree = this.sessionManager.getTree();
        const realLeafId = this.sessionManager.getLeafId();
        const initialFilterMode = this.settingsManager.getTreeFilterMode();`;

const sourceReplacement = `    ${MARKER}
    async showTreeSelector(initialSelectedId) {
        const inmemoryTreeOptions = {
            type: "session_tree_open",
            tree: this.sessionManager.getTree(),
            currentLeafId: this.sessionManager.getLeafId(),
            initialFilterMode: this.settingsManager.getTreeFilterMode(),
            skipSummaryPrompt: this.settingsManager.getBranchSummarySkipPrompt(),
        };
        await this.session.extensionRunner.emit(inmemoryTreeOptions);
        if (inmemoryTreeOptions.cancel) return;
        const { tree, currentLeafId: realLeafId, initialFilterMode } = inmemoryTreeOptions;`;

const bundleStart = "showTreeSelector(initialSelectedId){let tree=this.sessionManager.getTree(),realLeafId=this.sessionManager.getLeafId(),initialFilterMode=this.settingsManager.getTreeFilterMode();";
const bundleReplacement = `${MARKER}async showTreeSelector(initialSelectedId){const inmemoryTreeOptions={type:"session_tree_open",tree:this.sessionManager.getTree(),currentLeafId:this.sessionManager.getLeafId(),initialFilterMode:this.settingsManager.getTreeFilterMode(),skipSummaryPrompt:this.settingsManager.getBranchSummarySkipPrompt()};await this.session.extensionRunner.emit(inmemoryTreeOptions);if(inmemoryTreeOptions.cancel)return;let{tree,currentLeafId:realLeafId,initialFilterMode}=inmemoryTreeOptions;`;

function replaceOnce(source, before, after, path) {
  if (source.split(before).length !== 2) throw new Error(`宿主文件与已验证版本不一致，未修改：${path}`);
  return source.replace(before, after);
}

function treeTransform(source, path, bundled) {
  if (source.includes(MARKER)) {
    if (!source.includes("session_tree_open") || !source.includes("!inmemoryTreeOptions.skipSummaryPrompt")) {
      throw new Error(`检测到不完整的树接口补丁，未修改：${path}`);
    }
    return source;
  }
  const withHook = replaceOnce(source, bundled ? bundleStart : sourceStart, bundled ? bundleReplacement : sourceReplacement, path);
  return replaceOnce(withHook,
    bundled ? "if(!this.settingsManager.getBranchSummarySkipPrompt())" : "if (!this.settingsManager.getBranchSummarySkipPrompt())",
    bundled ? "if(!inmemoryTreeOptions.skipSummaryPrompt)" : "if (!inmemoryTreeOptions.skipSummaryPrompt)", path);
}

const sourceListStart = `    showSessionSelector() {
        this.showSelector((done) => {
            const selector = new SessionSelectorComponent((onProgress, signal) => SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress, signal), (onProgress, signal) => this.sessionManager.usesDefaultSessionDir()
                ? SessionManager.listAll(onProgress, signal)
                : SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress, signal), async (sessionPath) => {`;

const sourceListReplacement = `    ${LIST_MARKER}
    showSessionSelector() {
        const decorate = (loader) => async (onProgress, signal) => {
            const event = { type: "session_list", sessions: await loader(onProgress, signal), signal };
            await this.session.extensionRunner.emit(event);
            return event.sessions;
        };
        this.showSelector((done) => {
            const selector = new SessionSelectorComponent(decorate((onProgress, signal) => SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress, signal)), decorate((onProgress, signal) => this.sessionManager.usesDefaultSessionDir()
                ? SessionManager.listAll(onProgress, signal)
                : SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress, signal)), async (sessionPath) => {`;

const bundleListStart = "showSessionSelector(){this.showSelector(done=>{let selector=new SessionSelectorComponent((onProgress,signal)=>SessionManager.list(this.sessionManager.getCwd(),this.sessionManager.getSessionDir(),onProgress,signal),(onProgress,signal)=>this.sessionManager.usesDefaultSessionDir()?SessionManager.listAll(onProgress,signal):SessionManager.listAll(this.sessionManager.getSessionDir(),onProgress,signal),async sessionPath=>{";
const bundleListReplacement = `${LIST_MARKER}showSessionSelector(){const decorate=loader=>async(onProgress,signal)=>{const event={type:"session_list",sessions:await loader(onProgress,signal),signal};await this.session.extensionRunner.emit(event);return event.sessions};this.showSelector(done=>{let selector=new SessionSelectorComponent(decorate((onProgress,signal)=>SessionManager.list(this.sessionManager.getCwd(),this.sessionManager.getSessionDir(),onProgress,signal)),decorate((onProgress,signal)=>this.sessionManager.usesDefaultSessionDir()?SessionManager.listAll(onProgress,signal):SessionManager.listAll(this.sessionManager.getSessionDir(),onProgress,signal)),async sessionPath=>{`;

function listTransform(source, path, bundled, selectorOnly) {
  if (!selectorOnly) source = replaceOnce(source, bundled ? bundleListStart : sourceListStart,
    bundled ? bundleListReplacement : sourceListReplacement, path);
  if (bundled || selectorOnly) source = replaceOnce(source,
    bundled ? "normalizedMessage=(session.name??session.firstMessage).replace" : "const displayText = session.name ?? session.firstMessage;",
    bundled ? 'normalizedMessage=((session.displayBadge?session.displayBadge+" ":"")+(session.name??session.firstMessage)).replace'
      : `${LIST_MARKER}\n            const displayText = (session.displayBadge ? session.displayBadge + " " : "") + (session.name ?? session.firstMessage);`, path);
  return source;
}

function transformed(source, path, kind, legacy = false) {
  const bundled = kind === "bundle";
  if (kind !== "selector") source = treeTransform(source, path, bundled);
  return legacy || source.includes(LIST_MARKER) ? source : listTransform(source, path, bundled, kind === "selector");
}

async function prepare(directory, restore) {
  const root = await realpath(directory);
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (metadata.name !== HOST_NAME || metadata.version !== SUPPORTED_VERSION) {
    throw new Error(`界面兼容补丁仅适配 ${HOST_NAME} ${SUPPORTED_VERSION}，实际为 ${metadata.name} ${metadata.version}。`);
  }
  const files = [
    { path: join(root, "dist/modes/interactive/interactive-mode.js"), kind: "interactive" },
    { path: join(root, "dist/modes/interactive/components/session-selector.js"), kind: "selector" },
  ];
  const chunks = join(root, "dist/bundle/chunks");
  const candidates = [];
  for (const name of await readdir(chunks)) {
    if (!name.endsWith(".js")) continue;
    const path = join(chunks, name);
    const source = await readFile(path, "utf8");
    if (source.includes(bundleStart) || source.includes(MARKER)) candidates.push({ path, kind: "bundle" });
  }
  if (candidates.length !== 1) throw new Error(`未找到唯一的原生界面 bundle，未修改：${root}`);
  files.push(...candidates);
  const changes = [];
  for (const { path, kind } of files) {
    const current = await readFile(path, "utf8");
    let original;
    try { original = await readFile(path + BACKUP_SUFFIX, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (original !== undefined && current !== original &&
      transformed(original, path, kind) !== current && transformed(original, path, kind, true) !== current) {
      throw new Error(`宿主文件还包含其他修改，拒绝覆盖：${path}`);
    }
    if (restore) {
      if (!current.includes(MARKER) && !current.includes(LIST_MARKER)) continue;
      if (original === undefined) throw new Error(`缺少宿主原文件备份，拒绝恢复：${path}`);
      changes.push({ path, current, next: original, restore: true });
    } else {
      if ((current.includes(MARKER) || current.includes(LIST_MARKER)) && original === undefined) {
        throw new Error(`缺少宿主原文件备份，拒绝更新：${path}`);
      }
      const next = transformed(original ?? current, path, kind);
      if (next !== current) changes.push({ path, current, next, restore: false });
    }
  }
  return { root, changes };
}

async function writeChange(change) {
  const { path, next, current, restore } = change;
  if (await readFile(path, "utf8") !== current) throw new Error(`检查后宿主文件发生变化，拒绝覆盖：${path}`);
  if (!restore) {
    try { await copyFile(path, path + BACKUP_SUFFIX, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      // prepare() already verified original, legacy, or current patch content.
    }
  }
  const temporary = `${path}.inmemory-install-${process.pid}`;
  await writeFile(temporary, next, { mode: (await stat(path)).mode });
  await rename(temporary, path);
}

async function globalPackage(local) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const command = join(directory, "pi");
    try { await access(command, constants.X_OK); }
    catch { continue; }
    const executable = await realpath(command);
    if (executable.startsWith(`${local}/`)) continue;
    let current = dirname(executable);
    while (current !== dirname(current)) {
      try {
        const metadata = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
        if (metadata.name === HOST_NAME) return current;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      current = dirname(current);
    }
    throw new Error(`无法从 pi 启动文件定位安装目录：${command}`);
  }
  throw new Error("PATH 中未找到全局 pi 命令。");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) if (arg !== "--global" && arg !== "--restore") throw new Error(`未知参数：${arg}`);
  const local = resolve(dirname(fileURLToPath(import.meta.resolve(HOST_NAME))), "..");
  const directories = new Set([local]);
  if (args.has("--global")) directories.add(await globalPackage(local));
  // Validate every file and version before changing either installation.
  const plans = [];
  for (const directory of directories) plans.push(await prepare(directory, args.has("--restore")));
  for (const { root, changes } of plans) {
    for (const change of changes) await writeChange(change);
    console.log(`Pi ${SUPPORTED_VERSION} 界面兼容接口${args.has("--restore") ? "已恢复" : "已就绪"}：${root}`);
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
