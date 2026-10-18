import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { initTheme, InteractiveMode, SessionManager, SessionSelectorComponent } from "@earendil-works/pi-coding-agent";
import { STATE_TYPE } from "../src/projection.ts";
import type { SessionListEvent } from "../src/tree-api.ts";
import { harness } from "./helpers.ts";

type Harness = Awaited<ReturnType<typeof harness>>;

async function list(h: Harness): Promise<SessionListEvent> {
  const event: SessionListEvent = { type: "session_list", sessions: await SessionManager.list(h.cwd, h.manager.getSessionDir()) };
  await h.session.extensionRunner.emit(event);
  return event;
}

test("resume badges identify fixed session categories without renaming or rewriting history", async () => {
  const h = await harness({ persisted: true });
  try {
    await h.mount();
    h.respond("initial reply");
    await h.session.prompt("current first message");
    h.session.setSessionName("Current title");
    const ordinary = SessionManager.create(h.cwd, h.manager.getSessionDir());
    ordinary.appendMessage({ role: "user", content: "ordinary first message", timestamp: Date.now() });
    const reply = h.report();
    assert(reply.type === "message" && reply.message.role === "assistant");
    ordinary.appendMessage(reply.message);
    ordinary.appendSessionInfo("Ordinary title");
    const activeBytes = await readFile(h.manager.getSessionFile()!);
    const plainBytes = await readFile(ordinary.getSessionFile()!);
    const active = await list(h);
    assert.equal(active.sessions.find((info) => info.id === h.manager.getSessionId())?.displayBadge, "[InMemory]");
    assert.equal(active.sessions.find((info) => info.id === ordinary.getSessionId())?.displayBadge, undefined);
    assert.equal(active.sessions.find((info) => info.id === h.manager.getSessionId())?.name, "Current title");
    assert.equal(active.sessions.find((info) => info.id === ordinary.getSessionId())?.name, "Ordinary title");
    assert.deepEqual(await readFile(h.manager.getSessionFile()!), activeBytes);
    assert.deepEqual(await readFile(ordinary.getSessionFile()!), plainBytes);
    await h.session.prompt("/memory off");
    const unchanged = await list(h);
    assert.equal(unchanged.sessions.find((info) => info.id === h.manager.getSessionId())?.displayBadge, "[InMemory]");
    await h.session.prompt("/memory on");
    assert.equal((await list(h)).sessions.find((info) => info.id === h.manager.getSessionId())?.displayBadge, "[InMemory]");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("badges remain InMemory on legacy disabled routes; read-only metadata cache recognizes newly created categories", async () => {
  const h = await harness({ persisted: true });
  try {
    await h.mount();
    h.respond("memory reply");
    await h.session.prompt("memory task");
    const memory = h.report();
    const source = h.checkpoints().at(-1)!;
    h.manager.appendCustomEntry(STATE_TYPE, { ...source, enabled: false, kind: "off" });
    assert.equal((await list(h)).sessions.find((info) => info.id === h.manager.getSessionId())?.displayBadge, "[InMemory]");
    h.manager.branch(memory.id);
    assert.equal((await list(h)).sessions.find((info) => info.id === h.manager.getSessionId())?.displayBadge, "[InMemory]");
    const other = SessionManager.create(h.cwd, h.manager.getSessionDir());
    other.appendMessage({ role: "user", content: "other session", timestamp: Date.now() });
    const reply = h.report();
    assert(reply.type === "message" && reply.message.role === "assistant");
    other.appendMessage(reply.message);
    const initialOther = await readFile(other.getSessionFile()!);
    assert.equal((await list(h)).sessions.find((info) => info.id === other.getSessionId())?.displayBadge, undefined);
    assert.deepEqual(await readFile(other.getSessionFile()!), initialOther);
    const enabled = { ...source, sessionId: other.getSessionId() };
    other.appendCustomEntry(STATE_TYPE, { ...enabled, enabled: false, kind: "off" });
    const path = other.getSessionFile()!;
    const bytes = await readFile(path);
    assert.equal((await list(h)).sessions.find((info) => info.id === other.getSessionId())?.displayBadge, "[InMemory]");
    assert.deepEqual(await readFile(path), bytes);
    other.appendCustomEntry(STATE_TYPE, { ...enabled, kind: "mount" });
    assert.equal((await list(h)).sessions.find((info) => info.id === other.getSessionId())?.displayBadge, "[InMemory]");
    other.resetLeaf();
    other.appendSessionInfo("Legacy ordinary route");
    assert.equal((await list(h)).sessions.find((info) => info.id === other.getSessionId())?.displayBadge, "[InMemory]");
    // A malformed trailing line is skipped just as it is by the host loader.
    await writeFile(path, `${await readFile(path, "utf8")}\ninvalid trailing record\n`);
    assert.equal((await list(h)).sessions.find((info) => info.id === other.getSessionId())?.displayBadge, "[InMemory]");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("native resume selector renders badges, preserves name filtering and selects the original session path in both scopes", async () => {
  let events = 0;
  const h = await harness({ persisted: true, probe: (pi) => pi.on("session_list", () => { events++; }) });
  try {
    await h.mount();
    h.respond("memory reply");
    await h.session.prompt("memory session");
    const ordinary = SessionManager.create(h.cwd, h.manager.getSessionDir());
    ordinary.appendMessage({ role: "user", content: "ordinary session", timestamp: Date.now() });
    const reply = h.report();
    assert(reply.type === "message" && reply.message.role === "assistant");
    ordinary.appendMessage(reply.message);
    ordinary.appendSessionInfo("Named ordinary session");
    let selector: SessionSelectorComponent | undefined;
    let selected: string | undefined;
    initTheme("dark", false);
    const host = {
      sessionManager: h.manager, session: h.session, keybindings: undefined,
      ui: { requestRender: () => {} }, shutdown: () => {},
      showSelector: (factory: (done: () => void) => { component: SessionSelectorComponent }) => { selector = factory(() => {}).component; },
      handleResumeSession: async (path: string) => { selected = path; },
    };
    const show = Reflect.get(InteractiveMode.prototype, "showSessionSelector") as (this: typeof host) => void;
    show.call(host);
    assert(selector);
    const loaded = async (count: number) => {
      for (let i = 0; i < 100; i++) {
        if (events >= count && selector!.getSessionList().getSelectedSessionPath()) return;
        await setTimeout(10);
      }
      assert.fail("Native resume selector did not finish loading");
    };
    await loaded(1);
    assert(selector.render(120).some((line) => line.includes("[InMemory]")));
    const sessions = selector.getSessionList();
    sessions.setNameFilter("named");
    assert.equal(sessions.getSelectedSessionPath(), ordinary.getSessionFile());
    assert(!selector.render(120).some((line) => line.includes("[InMemory]")));
    sessions.setNameFilter("all");
    selector.handleInput("\t");
    await loaded(2);
    assert(selector.render(120).some((line) => line.includes("[InMemory]")));
    selector.handleInput("Named ordinary");
    assert.equal(sessions.getSelectedSessionPath(), ordinary.getSessionFile());
    selector.handleInput("\r");
    assert.equal(selected, ordinary.getSessionFile());
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("an unreadable session does not hide other resume entries; cancellation remains supported", async () => {
  const h = await harness({ persisted: true });
  try {
    await h.mount();
    h.respond("reply");
    await h.session.prompt("task");
    const entries = (await list(h)).sessions;
    const event: SessionListEvent = { type: "session_list", sessions: [
      { ...entries[0]!, path: join(h.cwd, "missing.jsonl"), id: "missing" }, ...entries,
    ] };
    await h.session.extensionRunner.emit(event);
    assert.equal(event.sessions.length, 2);
    assert.equal(event.sessions[1]!.displayBadge, "[InMemory]");
    // The host ignores the result after aborting a load; the extension does not
    // continue reading a second batch or report a spurious session error.
    const cancelled: SessionListEvent = { type: "session_list", sessions: entries.map(({ displayBadge: _, ...info }) => info),
      signal: AbortSignal.abort() };
    await h.session.extensionRunner.emit(cancelled);
    assert(cancelled.sessions.every((info) => info.displayBadge === undefined));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
