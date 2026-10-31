import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { desktopConnection } from "./cdp.ts";
import { historyRequest } from "../history/desktop-client.ts";
import { httpError } from "../http.ts";

const source = readFile(new URL("./claude-activation.js", import.meta.url), "utf8");
const opened = new Map<string, { hostId: string }>();
const flights = new Map<string, Promise<void>>();
export const hasOpenedClaude = (id: string) => opened.has(id);
export const openedClaudeHost = (id: string) => opened.get(id)?.hostId;

async function invoke(method: "open" | "send", args: unknown[]) {
  let connection;
  try { connection = await desktopConnection("claude"); }
  catch { throw httpError(409, "请先完全退出 Claude，再用电脑桌面的“claude 手机控制”快捷方式打开一次；之后可在手机直接打开历史会话"); }
  await connection.evaluate(await source);
  const result = await connection.evaluate(`globalThis.__remoteccClaudeActivation.${method}(...${JSON.stringify(args)}).then(value=>({value}),error=>({error:String(error?.message||'桌面未能打开会话')}))`);
  if (result?.error || !result) throw httpError(409, result?.error || "桌面未能确认会话状态");
  return result.value;
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
export async function sendOpenedClaude(id: string, text: string) {
  const host = opened.get(id);
  if (!host) throw httpError(409, "请先打开这条桌面会话");
  const identity = await historyRequest("claudeIdentity", id);
  await invoke("send", [host.hostId, identity, text, randomUUID()]);
}
