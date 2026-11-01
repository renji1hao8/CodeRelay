import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Native transport adapters are supplied by the user's installed MIT-licensed
// Codex–Claude Desktop Bridge. Keep its process/session identity checks intact.
let bridgePromise: Promise<{ codex: any; claude: any; hosts: any }> | null = null;
export function bridge() {
  return bridgePromise ??= (async () => {
    const root = process.env.REMOTE_CC_DESKTOP_BRIDGE_DIR || path.resolve(import.meta.dirname, "../../vendor/desktop-bridge");
    const load = (name: string) => import(pathToFileURL(path.join(root!, "lib", name + ".mjs")).href);
    const [codex, claude, hosts] = await Promise.all([load("codex-desktop"), load("claude-desktop"), load("codex-host")]);
    return { codex, claude, hosts };
  })().catch(error => { bridgePromise = null; throw error; });
}

// Same length-prefixed local app-tools protocol used by the bridge. The context
// comes exclusively from its verified registry; never invent a caller task ID.
export function rpc(pipe: string, method: string, params: unknown, timeoutMs = 5000): Promise<any> {
  if (!/^\\\\\.\\pipe\\(?:LOCAL\\)?[^\\/\r\n\0]+$/i.test(pipe)) throw new Error("桌面接口地址无效");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let pending = Buffer.alloc(0), done = false;
    const finish = (error?: Error, result?: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("桌面端响应超时")), timeoutMs);
    socket.on("error", () => finish(new Error("桌面端未运行或接口已失效")));
    socket.on("end", () => finish(new Error("桌面端连接已关闭")));
    socket.on("connect", () => {
      const data = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
      const head = Buffer.alloc(4); head.writeUInt32LE(data.length);
      socket.write(Buffer.concat([head, data]));
    });
    socket.on("data", data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 4) {
        const length = pending.readUInt32LE();
        if (length > 8 * 1024 * 1024) return finish(new Error("桌面响应过大"));
        if (pending.length < length + 4) return;
        let frame: any;
        try { frame = JSON.parse(pending.subarray(4, 4 + length).toString("utf8")); }
        catch { return finish(new Error("桌面响应格式无效")); }
        pending = pending.subarray(4 + length);
        if (String(frame.id) !== "1") continue;
        if (frame.error) return finish(new Error("桌面端拒绝请求，请检查会话和桌面接口版本"));
        finish(undefined, frame.result); return;
      }
    });
  });
}

export function unwrap(result: any): any {
  if (result?.success === false) throw new Error("桌面操作失败，请在电脑上检查该会话");
  if (result?.structuredContent) return result.structuredContent;
  for (const item of result?.contentItems ?? result?.content ?? []) {
    if (typeof item.text !== "string") continue;
    try { return JSON.parse(item.text); } catch { /* Additional human-readable text. */ }
  }
  return result;
}

let hostCache: { at: number; host: any; tools: any[] } | null = null;
let discovering: Promise<{ host: any; tools: any[] }> | null = null;
export async function codexEndpoint() {
  if (hostCache && Date.now() - hostCache.at < 30_000) return hostCache;
  return discovering ??= (async () => {
    const { hosts } = await bridge();
    const deadline = Date.now() + 5000;
    for (const host of hosts.getCodexHosts().slice(0, 4)) {
      if (Date.now() >= deadline) break;
      try {
        const catalog = await rpc(host.pipePath, "tools/list", { threadStartKind: "all" }, Math.min(1000, deadline - Date.now()));
        if (!Array.isArray(catalog?.tools)) continue;
        const listing = catalog.tools.find((t: any) => t.name === "list_threads");
        if (!listing?.namespace) continue;
        unwrap(await rpc(host.pipePath, "tools/call", {
          callerSource: "codex", namespace: listing.namespace, tool: listing.name, arguments: { limit: 1 },
          threadId: host.threadId, callId: crypto.randomUUID(), turnId: crypto.randomUUID(),
        }, Math.max(1, Math.min(2000, deadline - Date.now()))));
        hostCache = { at: Date.now(), host, tools: catalog.tools };
        return hostCache;
      } catch { /* Read-only discovery may try another registered endpoint. */ }
    }
    throw new Error("Codex 桌面端未连接，请打开桌面端并启用桥接插件");
  })().finally(() => { discovering = null; });
}

export async function codexTool(name: string, args: unknown) {
  const { host, tools } = await codexEndpoint();
  const tool = tools.find(t => t.name === name);
  if (!tool?.namespace) throw new Error(`当前桌面端不支持 ${name}`);
  try {
    return unwrap(await rpc(host.pipePath, "tools/call", {
      callerSource: "codex", namespace: tool.namespace, tool: name, arguments: args,
      threadId: host.threadId, callId: crypto.randomUUID(), turnId: crypto.randomUUID(),
    }, 15000));
  } catch (error) { hostCache = null; throw error; }
}

export async function sendNative(provider: "claude" | "codex", id: string, message: string, requestId: string) {
  // Claude's peer inbox is consumed by the running agent and has no model ACK.
  // Mobile continuation must use LocalSessions.sendMessage, including when idle.
  if (provider === "claude") throw new Error("Claude 手机续接必须使用桌面输入接口");
  const b = await bridge();
  const { host } = await codexEndpoint();
  await b.codex.sendToCodex({ pipePath: host.pipePath, contextThreadId: host.threadId,
    threadId: id, message, callId: requestId, turnId: requestId });
}

export async function assertNoClaudeDesktopWriter(id: string) {
  const b = await bridge();
  if (b.claude.discoverClaudeSessions().some((s: any) => s.sessionId === id && s.entrypoint.startsWith("claude-desktop"))) {
    throw new Error("这条会话正在 Claude 桌面端运行，请切换到桌面同步；禁止另起 CLI 写入同一会话");
  }
}

export async function assertNoCodexDesktopWriter(id: string) {
  const result = await codexTool("read_thread", { threadId: id, hostId: "local", turnLimit: 1 });
  if (result?.thread?.status?.type !== "notLoaded") throw new Error("桌面端仍持有此会话，或归属无法确认；请使用桌面同步，禁止另起 CLI");
}
