import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { desktopConnection, forgetDesktopConnection } from "./cdp.ts";
import { bridge } from "./native.ts";
import { claudeDesktopBinding, claudeWriterConflict } from "./claude-sessions.ts";
import { historyRequest } from "../history/desktop-client.ts";
import { httpError } from "../http.ts";

const source = readFile(new URL("./claude-activation.js", import.meta.url), "utf8");
const opened = new Map<string, { hostId: string }>();
const flights = new Map<string, Promise<void>>();
export const hasOpenedClaude = (id: string) => opened.has(id);
export const openedClaudeHost = (id: string) => opened.get(id)?.hostId;

async function invoke(method: "open" | "send" | "verify", args: unknown[]) {
  let connection;
  try { connection = await desktopConnection("claude"); }
  catch { throw httpError(409, "请先完全退出 Claude，再用电脑桌面的“claude 手机控制”快捷方式打开一次；之后可在手机直接打开历史会话"); }
  try {
    await connection.evaluate(await source);
    const result = await connection.evaluate(`globalThis.__remoteccClaudeActivation.${method}(...${JSON.stringify(args)}).then(value=>({value}),error=>({error:String(error?.message||'桌面未能打开会话')}))`);
    if (result?.error || !result) throw httpError(409, result?.error || "桌面未能确认会话状态");
    return result.value;
  } catch (error) { forgetDesktopConnection("claude"); throw error; }
}
export async function openClaude(id: string) {
  if (flights.has(id)) return flights.get(id);
  const work = (async () => {
    const identity = await historyRequest("claudeIdentity", id);
    const result = await invoke("open", [identity]);
    if (!result?.hostId) throw httpError(409, "桌面未能确认会话归属");
    opened.set(id, { hostId: result.hostId });
  })().finally(() => flights.delete(id));
  flights.set(id, work); return work;
}
/** Preflight is read-only and runs before the durable write intent is recorded. */
export async function prepareClaudeSend(id: string, text: string) {
  const b = await bridge();
  const registrations = b.claude.discoverClaudeSessions();
  const host = opened.get(id);
  if (claudeWriterConflict(id, registrations, host?.hostId)) throw httpError(409, "该会话被其他进程占用，消息未发送");
  const live = registrations.some((row: any) => row.sessionId === id);
  const binding = live ? claudeDesktopBinding(id, registrations, b.claude.resolveClaudeSession) : null;
  const hostId = binding?.hostSessionId ?? host?.hostId;
  if (!hostId) throw httpError(409, "请先打开这条桌面会话；消息未发送");
  const identity = await historyRequest("claudeIdentity", id);
  const normal = (value: string) => value.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  if (binding && normal(binding.cwd) !== normal(identity.cwd)) throw httpError(409, "桌面会话工作目录与原历史不一致，消息未发送");
  await invoke("verify", [hostId, identity, binding?.hostSessionId]);
  const messageUuid = randomUUID();
  return async () => {
    const current = b.claude.discoverClaudeSessions();
    if (claudeWriterConflict(id, current, hostId)) throw httpError(409, "桌面会话归属已变化，消息未发送");
    if (binding) {
      const next = claudeDesktopBinding(id, current, b.claude.resolveClaudeSession);
      if (JSON.stringify(next) !== JSON.stringify(binding)) throw httpError(409, "桌面会话进程已变化，消息未发送");
    } else if (current.some((row: any) => row.sessionId === id)) {
      // Do not adopt a process that appeared after read-only verification.
      throw httpError(409, "桌面会话进程已变化，请重新打开");
    }
    await invoke("send", [hostId, identity, text, messageUuid, binding?.hostSessionId]);
  };
}
