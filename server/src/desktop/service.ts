import { db } from "../db.ts";
import type { DesktopProvider, DesktopSession, DesktopSessionPage, DesktopDetail } from "@remote-cc/shared";
import { bridge, codexTool, sendNative } from "./native.ts";
import { codexMessages, codexSummary } from "./mapping.ts";
import { historyRequest } from "../history/desktop-client.ts";
import { activeSessionForCcId } from "../cc/registry.ts";
import { httpError } from "../http.ts";
import { createDeliveryTable, deliverOnce } from "./delivery.ts";
import { claudeDesktopPage, claudeWriterConflict } from "./claude-sessions.ts";
import { hasOpenedClaude, openedClaudeHost, openClaude, prepareClaudeSend } from "./claude-open.ts";
import { codexLive } from "./codex-live.ts";

const listCache = new Map<string, { at: number; value: DesktopSessionPage }>();
const listFlights = new Map<string, Promise<DesktopSessionPage>>();
export async function desktopList(provider: DesktopProvider, cursor?: string): Promise<DesktopSessionPage> {
  const key = `${provider}:${cursor ?? ""}`;
  const old = listCache.get(key);
  if (old && Date.now() - old.at < 5000) return old.value;
  const pending = listFlights.get(key);
  if (pending) return pending;
  const work = (async () => {
    let page: DesktopSessionPage;
    if (provider === "codex") {
      const raw = await codexTool("list_threads", { mode: "history", source: "codex", hostId: "local", limit: 50, ...(cursor ? { cursor } : {}) });
      const seen = new Set<string>();
      page = { sessions: [...(raw.pinnedThreads ?? []), ...(raw.threads ?? [])]
        .filter(t => t.kind === "codex" && (!t.hostId || t.hostId === "local"))
        .map(codexSummary).filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; }), nextCursor: raw.nextCursor ?? null };
    } else {
      const b = await bridge();
      const live: any[] = b.claude.discoverClaudeSessions();
      const stored = await historyRequest("sessions") as any[];
      page = claudeDesktopPage(stored, live);
      page.sessions = page.sessions.map(session => !session.canSend && hasOpenedClaude(session.id) && !claudeWriterConflict(session.id, live, openedClaudeHost(session.id)) ? { ...session, canSend: true, status: "idle", notice: undefined } : session);
    }
    listCache.set(key, { at: Date.now(), value: page });
    return page;
  })().finally(() => listFlights.delete(key));
  listFlights.set(key, work); return work;
}

const details = new Map<string, { at: number; value: DesktopDetail }>();
const detailFlights = new Map<string, Promise<DesktopDetail>>();
export async function desktopDetail(provider: DesktopProvider, id: string, cursor?: string): Promise<DesktopDetail> {
  const key = `${provider}:${id}:${cursor ?? ""}`;
  const cached = details.get(key);
  if (cached && Date.now() - cached.at < 1200) return cached.value;
  if (detailFlights.has(key)) return detailFlights.get(key)!;
  const work = (async (): Promise<DesktopDetail> => {
    if (provider === "codex") {
      if (!cursor || cursor.startsWith("codex-local-v1:")) {
        const live = !cursor ? codexLive(id) : { messages: [] };
        const local = await historyRequest("codexDetail", id, cursor);
        if (local) {
          void desktopList("codex").catch(() => {});
          const page = listCache.get("codex:")?.value;
          const summary = page?.sessions.find(s => s.id === id);
          const known = new Set(local.messages.map((m: any) => m.uuid));
          const first = local.messages[0]?.ts;
          const tail = live.messages.filter(m => !known.has(m.uuid) && (!first || m.ts && Date.parse(m.ts) >= Date.parse(first)));
          return { session: { ...local.session, ...summary, ...("busy" in live && live.busy !== undefined ? { status: live.busy ? "busy" : "idle" } : {}), ...(local.notice ? { notice: local.notice } : {}) }, messages: [...local.messages, ...tail], olderCursor: local.olderCursor, fetchedAt: new Date().toISOString() };
        }
        if (cursor) throw httpError(409, "本机历史位置已变化，请重新打开会话");
      }
      const raw = await codexTool("read_thread", { threadId: id, hostId: "local", turnLimit: 2, includeOutputs: true, maxOutputCharsPerItem: 2000, ...(cursor ? { cursor } : {}) });
      return { session: codexSummary(raw.thread), messages: codexMessages(raw.turns ?? [], raw.page?.order === "newest_first"),
        olderCursor: raw.page?.nextCursor ?? null, fetchedAt: new Date().toISOString() };
    }
    const page = await desktopList(provider);
    const session = page.sessions.find(s => s.id === id);
    if (!session) throw httpError(404, "没有这条桌面会话");
    const history = await historyRequest("detail", id, cursor);
    return { session, ...history, fetchedAt: new Date().toISOString() };
  })().then(value => {
    if (details.size > 100) details.delete(details.keys().next().value!);
    details.set(key, { at: Date.now(), value }); return value;
  }).finally(() => detailFlights.delete(key));
  detailFlights.set(key, work); return work;
}

export function initDeliveryLedger() {
  createDeliveryTable(db);
}
export async function desktopOpen(provider: DesktopProvider, id: string) {
  if (provider !== "claude") throw httpError(400, "此操作仅适用于 Claude 历史会话");
  const b = await bridge();
  const owners = b.claude.discoverClaudeSessions().filter((s: any) => s.sessionId === id);
  if (activeSessionForCcId(id) || owners.some((s: any) => !s.entrypoint.startsWith("claude-desktop")) || owners.length > 1) throw httpError(409, "该会话仍被其他进程占用，请先结束重复实例");
  if (!owners.length) await openClaude(id);
  listCache.clear(); details.clear();
  return (await desktopList("claude")).sessions.find(session => session.id === id);
}
export async function desktopSend(provider: DesktopProvider, id: string, text: string, requestId: string, deviceId: string) {
  const target = `${provider}:${id}`;
  if (db.prepare("SELECT 1 FROM desktop_deliveries WHERE request_id=?").get(requestId)) {
    return deliverOnce(db, { requestId, deviceId, target, text }, async () => { throw new Error("already recorded"); });
  }
  if (provider === "claude" && activeSessionForCcId(id)) throw httpError(409, "这条会话仍由独立 CLI 占用，请先结束独立运行再连接桌面");
  const send = provider === "claude" ? await prepareClaudeSend(id, text) : () => sendNative("codex", id, text, requestId);
  const result = await deliverOnce(db, { requestId, deviceId, target, text }, send);
  listCache.clear(); details.clear();
  return result;
}
