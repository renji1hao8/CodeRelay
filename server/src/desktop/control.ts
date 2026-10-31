import { readFile } from "node:fs/promises";
import type { DesktopAction, DesktopActionResult, DesktopControl, DesktopProvider } from "@remote-cc/shared";
import { bridge } from "./native.ts";
import { desktopConnection, forgetDesktopConnection } from "./cdp.ts";
import { httpError } from "../http.ts";

const source = readFile(new URL("./control-relay.js", import.meta.url), "utf8");
const unavailable = new Map<string, { until: number; value: DesktopControl }>();
async function invoke(provider: DesktopProvider, id: string, operation: "snapshot" | "action" | "output", value?: unknown) {
  let nativeId = id;
  if (provider === "claude") {
    const b = await bridge();
    const owners = b.claude.discoverClaudeSessions().filter((s: any) => s.sessionId === id && s.entrypoint.startsWith("claude-desktop"));
    if (owners.length !== 1 || !owners[0].hostSessionId) throw httpError(409, "请先在电脑上打开这条 Claude Code 会话");
    // Verify the registered process before trusting its Desktop host-session id.
    b.claude.resolveClaudeSession(id);
    nativeId = owners[0].hostSessionId;
  }
  try {
    const connection = await desktopConnection(provider);
    await connection.evaluate(await source);
    const result = await connection.evaluate(`globalThis.__remoteccControl.${operation}(${JSON.stringify(nativeId)}${value === undefined ? "" : "," + JSON.stringify(value)}).then(value=>({value}),error=>({error:String(error?.message || '电脑未能完成操作')}))`);
    if (!result || result.error) throw httpError(409, result?.error || "电脑未能确认操作");
    return result.value;
  } catch (error) { forgetDesktopConnection(provider); throw error; }
}
export async function desktopControl(provider: DesktopProvider, id: string): Promise<DesktopControl> {
  const key = `${provider}:${id}`, prior = unavailable.get(key);
  if (prior && prior.until > Date.now()) return prior.value;
  try { return await invoke(provider, id, "snapshot"); }
  catch (error) {
    const value: DesktopControl = { connected: false, canInterrupt: false, turnKey: null, approvals: [], tasks: [], tasksKnown: false, notice: error instanceof Error ? error.message : "电脑控制尚未连接" };
    if (unavailable.size > 100) unavailable.delete(unavailable.keys().next().value!);
    unavailable.set(key, { until: Date.now() + 10000, value }); return value;
  }
}
export async function desktopAction(provider: DesktopProvider, id: string, action: DesktopAction): Promise<DesktopActionResult> {
  return invoke(provider, id, "action", action);
}
export async function desktopTaskOutput(provider: DesktopProvider, id: string, taskId: string) { return invoke(provider, id, "output", taskId); }
