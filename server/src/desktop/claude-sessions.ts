import type { DesktopSessionPage, DesktopSession } from "@remote-cc/shared";

type Stored = { id: string; title?: string | null; last_prompt?: string | null; project_path?: string | null; updated_at?: string | null };
type Live = { sessionId: string; hostSessionId?: string; name?: string; cwd?: string; status?: string; entrypoint: string };
export type ClaudeDesktopBinding = { sessionId: string; hostSessionId: string; cwd: string; pid: number; procStart: string; pidDomain: string; entrypoint: string };

/** The native registry/process check, never shared transcript text, authorizes a live host. */
export function claudeDesktopBinding(id: string, registrations: Live[], resolve: (id: string) => any): ClaudeDesktopBinding {
  const owners = registrations.filter(row => row.sessionId === id);
  const hostId = owners[0]?.hostSessionId;
  if (owners.length !== 1 || claudeWriterConflict(id, registrations, hostId) || !hostId || !/^local_[a-f0-9-]{36}$/i.test(hostId)) throw new Error("无法唯一核实 Claude 桌面会话，请关闭重复实例后重新打开");
  const current = resolve(id);
  if (current.sessionId !== id || current.hostSessionId !== hostId || !current.entrypoint.startsWith("claude-desktop") ||
      !Number.isSafeInteger(current.pid) || current.pid <= 0 || !current.procStart || !current.pidDomain || !current.cwd) throw new Error("Claude 桌面会话归属已变化，消息未发送");
  return { sessionId: id, hostSessionId: hostId, cwd: current.cwd, pid: current.pid, procStart: current.procStart, pidDomain: current.pidDomain, entrypoint: current.entrypoint };
}
export function claudeWriterConflict(id: string, registrations: Live[], hostId?: string) {
  const owners = registrations.filter(row => row.sessionId === id);
  return owners.length > 1 || owners.some(row => !row.entrypoint.startsWith("claude-desktop")) ||
    !!hostId && registrations.some(row => row.hostSessionId === hostId && row.sessionId !== id);
}

/** Eligibility is bound to the exact registered session, never its folder/title. */
export function claudeDesktopPage(stored: Stored[], registrations: Live[]): DesktopSessionPage {
  const live = registrations.filter(row => row.entrypoint.startsWith("claude-desktop"));
  const owners = new Map<string, Live[]>();
  for (const row of live) owners.set(row.sessionId, [...(owners.get(row.sessionId) ?? []), row]);
  const records = new Map(stored.map(row => [row.id, row]));
  for (const row of live) if (!records.has(row.sessionId)) records.set(row.sessionId, { id: row.sessionId });
  const sessions: DesktopSession[] = [...records.values()].map(row => {
    const matches = owners.get(row.id) ?? [], active = matches[0];
    const state = active?.status?.toLowerCase();
    return {
      id: row.id, provider: "claude", title: active?.name?.trim() || row.title || row.last_prompt?.slice(0, 80) || "未命名会话",
      cwd: active?.cwd || row.project_path || null, updatedAt: row.updated_at ?? null,
      status: !active ? "offline" : state === "idle" ? "idle" : /^(busy|running|working|thinking)$/.test(state ?? "") ? "busy" : "unknown",
      canSend: matches.length === 1 && !claudeWriterConflict(row.id, registrations),
      notice: claudeWriterConflict(row.id, registrations) ? "多个进程占用此会话，请先在电脑上关闭重复实例" : !active ? "可在手机打开这条桌面会话并继续" : undefined,
    };
  });
  sessions.sort((a, b) => Number(b.canSend) - Number(a.canSend) || Number(b.status === "busy") - Number(a.status === "busy") || (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
  return { sessions, nextCursor: null, ...(live.length ? {} : { notice: "请先在电脑上打开 Claude Code 会话" }) };
}
