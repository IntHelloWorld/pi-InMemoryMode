import { hash } from "./files.ts";

interface Block { type: string; cache_control?: { type: string; ttl?: string }; [key: string]: unknown }
interface Message { role: string; content: Block[] }
interface Payload { messages: Message[]; [key: string]: unknown }
export interface CacheAnchor {
  taskId: string;
  messageIndex: number;
  blockIndex: number;
  fingerprint: string;
  control: Block["cache_control"];
}

function fingerprint(message: Message): string {
  return hash(JSON.stringify({ ...message, content: message.content.map(({ cache_control: _cache, ...block }) => block) }));
}

function markerCount(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((count, item) => count + markerCount(item), 0);
  return Object.entries(value).reduce((count, [key, item]) => count + (key === "cache_control" ? 1 : markerCount(item)), 0);
}

/** Pinned to the tested Pi 1.3 Anthropic payload. Other provider payloads pass through. */
export function preserveTaskCache(value: unknown, taskId: string, previous?: CacheAnchor): { payload: unknown; anchor?: CacheAnchor } {
  if (!value || typeof value !== "object" || !("messages" in value) || !Array.isArray(value.messages)) return { payload: value };
  const payload = value as Payload;
  if (!payload.messages.every((message) => (message.role === "user" || message.role === "assistant") && Array.isArray(message.content))) return { payload: value };
  let anchor = previous?.taskId === taskId ? previous : undefined;
  if (!anchor) {
    for (let i = payload.messages.length - 1; i >= 0; i--) {
      const message = payload.messages[i]!;
      const blockIndex = message.role === "user" ? message.content.findLastIndex((block) => block.type === "text" && block.cache_control?.type === "ephemeral") : -1;
      if (blockIndex !== -1) {
        anchor = { taskId, messageIndex: i, blockIndex, fingerprint: fingerprint(message), control: message.content[blockIndex]!.cache_control };
        break;
      }
    }
  }
  if (!anchor) return { payload: value };
  const message = payload.messages[anchor.messageIndex];
  if (!message || fingerprint(message) !== anchor.fingerprint) return { payload: value };
  const block = message.content[anchor.blockIndex];
  if (!block || block.cache_control || markerCount(payload) >= 4) return { payload: value, anchor };
  const messages = payload.messages.slice();
  messages[anchor.messageIndex] = { ...message, content: message.content.map((item, index) => index === anchor.blockIndex ? { ...item, cache_control: anchor.control } : item) };
  return { payload: { ...payload, messages }, anchor };
}
