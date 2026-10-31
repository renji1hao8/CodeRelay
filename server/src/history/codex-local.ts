import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { ChatBlock, ChatMessage } from "@remote-cc/shared";
import { storeImage } from "../images.ts";
import { normalizeUserBlocks } from "@remote-cc/shared";

type Index = { scanned: number; boundaries: number[]; modified: number };
const indexes = new Map<string, Index>();
const MAX_RECORD = 16 * 1024 * 1024;
const clip = (text: unknown, limit = 12000) => typeof text === "string" ? text.length > limit ? text.slice(0, limit) + "\n…（内容过长，已截取）" : text : "";
function pageScaffold(text: unknown, kind: unknown): boolean {
  if (kind !== "additional_content.codex_apps_open_page" || typeof text !== "string") return false;
  const metadata = /^\s*<external_codex_apps_open_page>([\s\S]*)<\/external_codex_apps_open_page>\s*$/.exec(text);
  if (!metadata) return false;
  try { const value = JSON.parse(metadata[1]!); return !!value && Object.keys(value).every(k => k === "page_id") && "page_id" in value; } catch { return false; }
}

/** Read-only Codex rollout adapter; never resumes or modifies an agent session. */
export function rolloutMessage(record: any, uuid: string): ChatMessage | null {
  if (record?.type !== "response_item") return null;
  const p = record.payload;
  if (!p || typeof p !== "object") return null;
  let role: "user" | "assistant" = "assistant", blocks: ChatBlock[] = [];
  if (p.type === "message") {
    if (p.role !== "user" && p.role !== "assistant") return null;
    role = p.role;
    const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
    const text = (Array.isArray(p.content) ? p.content : []).filter((c: any, i: number) => ["input_text", "output_text", "text"].includes(c.type) && !pageScaffold(c.text, kinds?.[i])).map((c: any) => clip(c.text, 64000)).filter(Boolean).join("\n");
    if (text) blocks = [{ type: "text", text }];
    for (const content of Array.isArray(p.content) ? p.content : []) if (content.type === "input_image") {
      const url = typeof content.image_url === "string" ? content.image_url : content.image_url?.url;
      const match = typeof url === "string" ? /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url) : null;
      const stored = match && match[2]!.length < 7 * 1024 * 1024 ? storeImage(match[1]!, match[2]!) : null;
      blocks.push(stored ? { type: "image", ...stored } : { type: "text", text: "［图片附件］" });
    }
  } else if (["function_call", "custom_tool_call"].includes(p.type)) {
    let input: unknown = p.arguments ?? p.input ?? {};
    if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = { command: clip(input) }; } }
    if (input && typeof input === "object" && typeof (input as any).cmd === "string") input = { ...input, command: (input as any).cmd };
    const rendered = JSON.stringify(input);
    if (rendered.length > 16000) {
      const raw = input as any;
      input = { preview: clip(rendered), ...(typeof raw?.description === "string" ? { description: clip(raw.description, 1000) } : {}), ...(typeof raw?.command === "string" ? { command: clip(raw.command) } : {}) };
    }
    const name = /^(?:functions\.)?exec_command$/.test(p.name) ? "command" : String(p.name ?? "工具");
    blocks = [{ type: "tool_use", id: String(p.call_id ?? p.id ?? uuid), name, input }];
  } else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
    // An inbound app-tools message has a name and no call_id. Ordinary tool
    // outputs can contain example XML and must never become a user turn.
    if (p.name === "send_message_to_thread" && !p.call_id && typeof p.output === "string") {
      const incoming = /^\s*<codex_delegation>\s*<source_thread_id>[^<>]+<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/.exec(p.output);
      if (incoming) { role = "user"; blocks = [{ type: "text", text: incoming[1]! }]; }
    }
    if (!blocks.length)
    blocks = [{ type: "tool_result", toolUseId: String(p.call_id ?? p.id ?? uuid), text: clip(typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "")), isError: false }];
  }
  if (!blocks.length) return null;
  return { uuid, role, ts: typeof record.timestamp === "string" ? record.timestamp : null, blocks: role === "user" ? normalizeUserBlocks(blocks) : blocks };
}

function updateIndex(file: string, fd: number): Index {
  const stat = fs.fstatSync(fd);
  let state = indexes.get(file);
  if (!state || stat.size < state.scanned || stat.size === state.scanned && stat.mtimeMs !== state.modified) state = { scanned: 0, boundaries: [0], modified: stat.mtimeMs };
  const buffer = Buffer.alloc(65536);
  while (state.scanned < stat.size) {
    const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - state.scanned), state.scanned);
    if (!length) break;
    for (let i = 0; i < length; i++) if (buffer[i] === 10) state.boundaries.push(state.scanned + i + 1);
    state.scanned += length;
  }
  state.modified = stat.mtimeMs;
  indexes.delete(file); indexes.set(file, state);
  if (indexes.size > 6) indexes.delete(indexes.keys().next().value!);
  return state;
}

export function readRollout(file: string, id: string, cursor?: string) {
  const fd = fs.openSync(file, "r");
  try {
    const state = updateIndex(file, fd), offsets = state.boundaries;
    const before = cursor ? Number(cursor.replace(/^codex-local-v1:/, "")) : offsets.at(-1)!;
    if (cursor && !/^codex-local-v1:\d+$/.test(cursor) || !Number.isSafeInteger(before) || before < 0) throw new Error("历史游标无效");
    let low = 0, high = offsets.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (offsets[mid]! <= before) low = mid; else high = mid - 1; }
    if (offsets[low] !== before) throw new Error("历史已变化，请重新打开会话");
    let i = low - 1, bytes = 0, examined = 0, skipped = false;
    const messages: ChatMessage[] = [];
    while (i >= 0 && messages.length < 100 && examined++ < 1500) {
      const start = offsets[i]!, end = offsets[i + 1]!, length = end - start;
      if (bytes > 2 * 1024 * 1024 && messages.length) break;
      i--; bytes += length;
      if (length > MAX_RECORD) { skipped = true; continue; }
      const data = Buffer.alloc(length); fs.readSync(fd, data, 0, length, start);
      let record: any; try { record = JSON.parse(data.toString("utf8")); } catch { skipped = true; continue; }
      const itemId = record.payload?.id;
      const message = rolloutMessage(record, typeof itemId === "string" && itemId ? `codex-item-${id}-${itemId}` : `rollout-${id}-${start}`);
      if (message) message.sequence = start;
      if (message) messages.push(message);
    }
    return { messages: messages.reverse(), olderCursor: i >= 0 ? `codex-local-v1:${offsets[i + 1]}` : null,
      ...(skipped ? { notice: "部分超长或损坏记录未展示，其余消息已保留" } : {}) };
  } finally { fs.closeSync(fd); }
}

export function readLocalCodex(id: string, cursor?: string) {
  const home = path.resolve(process.env.REMOTE_CC_CODEX_HOME || process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  let databases: string[];
  try { databases = fs.readdirSync(home).filter(f => /^state_\d+\.sqlite$/.test(f)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0])); } catch { return null; }
  for (const name of databases) {
    const database = new DatabaseSync(path.join(home, name), { readOnly: true });
    try {
      const row = database.prepare("SELECT id,title,cwd,updated_at,rollout_path FROM threads WHERE id=?").get(id) as { id: string; title: string; cwd: string; updated_at: number; rollout_path: string } | undefined;
      if (!row) continue;
      // Codex also stores extended-length Win32 paths (\\?\C:\...). The JS
      // realpath fallback can try lstat("C:") and fail inside worker threads.
      const canonical = (value: string) => fs.realpathSync.native(value).replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "");
      const file = canonical(path.resolve(home, row.rollout_path)), base = canonical(home);
      const relative = path.relative(base, file);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(file) !== ".jsonl") throw new Error("本机会话历史路径无效");
      return { ...readRollout(file, id, cursor), session: { id, provider: "codex", title: row.title || "Codex 会话", cwd: row.cwd || null,
        updatedAt: new Date(row.updated_at < 1e12 ? row.updated_at * 1000 : row.updated_at).toISOString(), status: "unknown", canSend: true } };
    } finally { database.close(); }
  }
  return null;
}
