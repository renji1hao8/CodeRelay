import type { ChatMessage, DesktopSession } from "@remote-cc/shared";
import { messagesOfEntries } from "../codex/items.ts";

export function iso(value: unknown): string | null {
  if (typeof value === "string") return Number.isNaN(Date.parse(value)) ? null : value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}
export function codexSummary(raw: any): DesktopSession {
  const state = typeof raw.status === "string" ? raw.status : raw.status?.type;
  return { id: raw.id ?? raw.threadId, provider: "codex", title: raw.title ?? raw.name ?? "未命名会话",
    cwd: raw.cwd ?? null, updatedAt: iso(raw.updatedAt), canSend: true,
    status: state === "active" || state === "running" || state === "inProgress" ? "busy" : state === "idle" || state === "completed" ? "idle" : "unknown",
  };
}
export function codexMessages(turns: any[], newestFirst = false): ChatMessage[] {
  return (newestFirst ? [...turns].reverse() : turns).flatMap(turn => {
    const rows = (turn.items ?? []).map((item: any) => ({ turnId: turn.id,
      startedAtMs: typeof turn.startedAt === "number" ? (turn.startedAt < 1e12 ? turn.startedAt * 1000 : turn.startedAt) : undefined,
      item: { ...item, aggregatedOutput: item.aggregatedOutput ?? item.output?.text,
        changes: item.changes?.map((c: any) => ({ ...c, diff: typeof c.diff === "object" ? c.diff.text : c.diff })) },
    }));
    return messagesOfEntries(rows).map((message, i) => ({ ...message, uuid: `desktop-${turn.id}-${i}` }));
  });
}
