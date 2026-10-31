import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { config } from "../config.ts";
import type { DesktopProvider } from "@remote-cc/shared";

type Endpoint = { port: number; executable: string };
export class ControlUnavailable extends Error {}
const connected = new Map<DesktopProvider, Promise<DesktopConnection>>();

export class DesktopConnection {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", event => {
      let frame: any; try { frame = JSON.parse(String(event.data)); } catch { return; }
      const waiter = this.pending.get(frame.id); if (!waiter) return;
      this.pending.delete(frame.id); clearTimeout(waiter.timer);
      frame.error ? waiter.reject(new Error("电脑未能完成操作")) : waiter.resolve(frame.result);
    });
    const closed = () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ControlUnavailable("电脑端连接已断开")); } this.pending.clear(); };
    socket.addEventListener("close", closed); socket.addEventListener("error", closed);
  }
  static async connect(url: string) {
    const target = new URL(url);
    if (target.protocol !== "ws:" || target.hostname !== "127.0.0.1") throw new ControlUnavailable("电脑控制地址无效");
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new ControlUnavailable("电脑控制连接超时")); }, 3000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new ControlUnavailable("电脑控制未开启")); }, { once: true });
    });
    return new DesktopConnection(socket);
  }
  async call(method: string, params: unknown) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new ControlUnavailable("电脑端连接已断开");
    const id = ++this.nextId;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("电脑操作尚未确认，请刷新查看")); }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression: string) {
    const response = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error("电脑未能完成操作，请确认会话仍在运行");
    return response.result?.value;
  }
  close() { this.socket.close(); }
}

async function verifyOwner(endpoint: Endpoint, provider: DesktopProvider) {
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1024 || endpoint.port > 65535 ||
      typeof endpoint.executable !== "string" || !path.isAbsolute(endpoint.executable)) throw new ControlUnavailable("电脑控制配置无效");
  const script = path.resolve(import.meta.dirname, "../../scripts/verify-control-port.ps1");
  await new Promise<void>((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-Port", String(endpoint.port), "-Executable", endpoint.executable, "-Provider", provider], { windowsHide: true, timeout: 5000 }, error => {
      error ? reject(new ControlUnavailable("电脑控制连接尚未开启，请在电脑上启用后重开应用")) : resolve();
    }));
}
export function desktopConnection(provider: DesktopProvider): Promise<DesktopConnection> {
  const existing = connected.get(provider); if (existing) return existing;
  const work = (async () => {
    let settings: any;
    try { settings = JSON.parse(await readFile(path.join(config.dataDir, "desktop-control.json"), "utf8")); }
    catch { throw new ControlUnavailable("电脑控制尚未开启"); }
    const endpoint = settings[provider] as Endpoint | undefined;
    if (!endpoint) throw new ControlUnavailable("电脑控制尚未开启");
    await verifyOwner(endpoint, provider);
    let targets: any[];
    try {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/list`, { signal: AbortSignal.timeout(2000) });
      targets = await response.json() as any[];
    } catch { throw new ControlUnavailable("电脑控制尚未连接"); }
    for (const target of targets) {
      if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
      const url = new URL(target.webSocketDebuggerUrl);
      if (url.hostname !== "127.0.0.1" || Number(url.port) !== endpoint.port) continue;
      // The app's own preload is the capability check; never attach a browser
      // tab merely because it has a similar title.
      const connection = await DesktopConnection.connect(url.href);
      const valid = await connection.evaluate(provider === "claude"
        ? `typeof globalThis["claude.web"]?.LocalSessions?.getSession === "function"`
        : `globalThis.electronBridge?.windowType === "electron" && typeof globalThis.electronBridge?.sendMessageFromView === "function"`);
      if (valid) return connection;
      connection.close();
    }
    throw new ControlUnavailable("未找到电脑会话窗口");
  })().catch(error => { connected.delete(provider); throw error; });
  connected.set(provider, work); return work;
}
export function forgetDesktopConnection(provider: DesktopProvider) {
  const existing = connected.get(provider); connected.delete(provider);
  void existing?.then(connection => connection.close(), () => {});
}
