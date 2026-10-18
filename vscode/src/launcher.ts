import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

async function executableFile(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); }
  catch { return false; }
}

async function findExecutable(name: string, directories: string[]): Promise<string | undefined> {
  const candidates = isAbsolute(name) ? [name] : directories.flatMap((directory) =>
    process.platform === "win32" ? [join(directory, name), join(directory, `${name}.exe`), join(directory, `${name}.cmd`)] : [join(directory, name)]);
  for (const candidate of candidates) if (await executableFile(candidate)) return candidate;
}

/** A GUI-launched VS Code may have no Node on PATH, even when Pi's absolute path is set. */
export async function prepareLaunch(executable: string, nodeExecutable = "", environment = process.env): Promise<{
  executable: string; node: string; path: string;
}> {
  const inherited = (environment.PATH ?? environment.Path ?? "").split(delimiter).filter(Boolean);
  const standard = process.platform === "win32" ? [] : [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const directories = [...new Set([...inherited, ...standard])];
  const pi = await findExecutable(executable, directories);
  if (!pi) throw new Error(`Pi executable not found: ${executable}. Check the piInMemory.executable setting.`);
  // Prefer Node installed alongside Pi, then the inherited and common installation paths.
  const node = await findExecutable(nodeExecutable || "node", [dirname(pi), ...directories]);
  if (!node) throw new Error("Node.js was not found. Set piInMemory.nodeExecutable to the absolute path of the Node.js executable.");
  return { executable: pi, node, path: [...new Set([dirname(node), dirname(pi), ...directories])].join(delimiter) };
}
