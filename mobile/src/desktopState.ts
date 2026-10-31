import type { ChatMessage, DesktopDetail } from "./shared";
import { normalizeUserBlocks } from "./shared/user-content.ts";

/** A polling snapshot can update an existing item while a turn is still running. */
export function mergeDesktopMessages(previous: ChatMessage[], incoming: ChatMessage[], older = false): ChatMessage[] {
  const map = new Map<string, ChatMessage>();
  const source = older ? [...incoming, ...previous] : [...previous, ...incoming];
  for (const [i, message] of source.entries()) {
    const key = message.uuid ?? `${message.role}:${message.ts}:${JSON.stringify(message.blocks)}:${i}`;
    map.set(key, message);
  }
  const messages = [...map.values()];
  // Source position wins over wall clocks. Rollout records can share a timestamp
  // or be flushed later; receiving them later must not change causal order.
  messages.sort((a, b) => typeof a.sequence === "number" && typeof b.sequence === "number" ? a.sequence - b.sequence :
    a.ts && b.ts ? Date.parse(a.ts) - Date.parse(b.ts) : 0);
  return messages.slice(-1500);
}
export function containsDesktopText(messages: ChatMessage[], text: string): boolean {
  const expected = normalizeUserBlocks([{ type: "text", text }]);
  const wantedText = expected.filter(b => b.type === "text").map(b => b.text).join("\n");
  const paths = expected.filter(b => b.type === "image" || b.type === "file").map(b => b.path.replaceAll("\\", "/").toLowerCase());
  return messages.some(m => {
    if (m.role !== "user") return false;
    const blocks = normalizeUserBlocks(m.blocks);
    return (!wantedText || blocks.some(b => b.type === "text" && b.text.includes(wantedText))) && paths.every(p => blocks.some(b => (b.type === "image" || b.type === "file") && b.path.replaceAll("\\", "/").toLowerCase() === p));
  });
}
export function confirmsDesktopPending(messages: ChatMessage[], pending: { text: string; at: string }): boolean {
  return containsDesktopText(messages.filter(m => !!m.ts && Date.parse(m.ts) >= Date.parse(pending.at) - 5000), pending.text);
}
export function withDesktopPending(messages: ChatMessage[], pending: { requestId: string; text: string; at: string } | null): ChatMessage[] {
  if (!pending || confirmsDesktopPending(messages, pending)) return messages;
  const optimistic: ChatMessage = { uuid: pending.requestId, role: "user", ts: pending.at, blocks: [{ type: "text", text: pending.text }] };
  const index = messages.findIndex(m => m.ts && Date.parse(m.ts) >= Date.parse(pending.at));
  return index < 0 ? [...messages, optimistic] : [...messages.slice(0, index), optimistic, ...messages.slice(index)];
}
/** A long assistant turn can push the received user row out of the latest page. */
export async function findDesktopReceipt(first: DesktopDetail, pending: { text: string; at: string }, older: (cursor: string) => Promise<DesktopDetail>) {
  let page = first, messages = first.messages;
  const cursors = new Set<string>();
  for (let i = 0; i < 20; i++) {
    if (confirmsDesktopPending(page.messages, pending)) return { received: true, messages };
    if (!page.olderCursor || cursors.has(page.olderCursor) || page.messages.length && page.messages.every(m => m.ts && Date.parse(m.ts) < Date.parse(pending.at) - 5000)) break;
    cursors.add(page.olderCursor);
    page = await older(page.olderCursor);
    messages = mergeDesktopMessages(messages, page.messages, true);
  }
  return { received: confirmsDesktopPending(page.messages, pending), messages };
}
