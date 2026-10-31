import pty from "node-pty";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { TerminalServerFrame } from "@remote-cc/shared";
import { resolvePwsh } from "./pwsh.ts";
import { recordAudit } from "../db.ts";

export class InteractiveTerminal {
  readonly id = randomUUID();
  readonly process: pty.IPty;
  readonly screen: headless.Terminal;
  private serializer: serialize.SerializeAddon;
  private listeners = new Set<(frame: TerminalServerFrame) => void>();
  private seq = 0;
  private pendingBytes = 0;
  private disposed = false;
  private handlesReleased = false;
  running = true;
  exitCode: number | null = null;
  constructor(deviceId: string, cols: number, rows: number, options: { executable?: string; args?: string[]; cwd?: string; audit?: boolean } = {}) {
    const exe = options.executable || resolvePwsh();
    if (!exe) throw new Error("电脑上未找到 PowerShell 7");
    this.screen = new headless.Terminal({ cols, rows, scrollback: 1500, allowProposedApi: true });
    this.serializer = new serialize.SerializeAddon();
    this.screen.loadAddon(this.serializer as any);
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "CODEX_TURN_ID", "ELECTRON_RUN_AS_NODE"]) delete env[name];
    try {
      this.process = pty.spawn(exe, options.args ?? ["-NoLogo"], { name: "xterm-256color", cols, rows, cwd: options.cwd || homedir(), env: env as Record<string, string>, useConpty: true, useConptyDll: true });
    } catch { this.screen.dispose(); throw new Error("电脑终端启动失败，请检查 PowerShell 安装"); }
    // Only the backend responds to terminal device queries. Replays on phones
    // must never generate input or execute commands a second time.
    this.screen.onData(data => { if (this.running) this.process.write(data); });
    this.process.onData(data => {
      if (this.disposed) return;
      this.pendingBytes += data.length;
      if (this.pendingBytes > 256000) this.process.pause();
      this.screen.write(data, () => {
        if (this.disposed) return;
        this.pendingBytes -= data.length;
        this.broadcast({ t: "terminal_data", id: this.id, seq: ++this.seq, data });
        if (this.running && this.pendingBytes < 64000) this.process.resume();
      });
    });
    this.process.onExit(({ exitCode }) => {
      this.running = false; this.exitCode = exitCode;
      if (!this.disposed) this.screen.write("", () => { this.broadcast({ t: "terminal_exit", id: this.id, exitCode }); this.releaseNativeHandles(); });
    });
    if (options.audit !== false) recordAudit(deviceId, "terminal.open", this.id, "ok");
  }
  private broadcast(frame: TerminalServerFrame) { for (const listener of this.listeners) { try { listener(frame); } catch { this.listeners.delete(listener); } } }
  subscribe(listener: (frame: TerminalServerFrame) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  input(data: string) { if (!this.running || this.disposed) throw new Error("终端已退出，请新建终端"); this.process.write(data); }
  resize(cols: number, rows: number) {
    if (this.disposed || cols === this.screen.cols && rows === this.screen.rows) return;
    this.screen.resize(cols, rows); if (this.running) this.process.resize(cols, rows);
  }
  snapshot(): Promise<Extract<TerminalServerFrame, { t: "terminal_state" }>> {
    return new Promise(resolve => this.screen.write("", () => resolve({ t: "terminal_state", id: this.id, seq: this.seq, cols: this.screen.cols, rows: this.screen.rows, screen: this.serializer.serialize({ scrollback: 1000 }), running: this.running, exitCode: this.exitCode })));
  }
  private releaseNativeHandles() {
    if (this.handlesReleased) return; this.handlesReleased = true;
    const agent = (this.process as any)._agent;
    agent?._conoutSocketWorker?.dispose();
    agent?._inSocket?.destroy(); agent?._outSocket?.destroy();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.listeners.clear();
    if (this.running) { try { this.process.kill(); } catch { /* Already exited. */ } }
    // node-pty 1.1.0's bundled ConPTY waits for one more output event before
    // disposing its bridge worker. A closed console may never emit that event.
    // This is cleanup of this terminal's own handles, after the public kill.
    this.releaseNativeHandles();
    this.running = false; this.screen.dispose();
  }
}

const terminals = new Map<string, InteractiveTerminal>();
export function terminalFor(deviceId: string, cols: number, rows: number, fresh = false) {
  let terminal = terminals.get(deviceId);
  if (fresh && terminal) { terminal.dispose(); terminals.delete(deviceId); terminal = undefined; recordAudit(deviceId, "terminal.close", null, "ok"); }
  if (!terminal) {
    if (terminals.size >= 8) throw new Error("终端数量已达上限，请先关闭不用的终端");
    terminal = new InteractiveTerminal(deviceId, cols, rows); terminals.set(deviceId, terminal);
  }
  return terminal;
}
export function closeTerminalForDevice(id: string) { terminals.get(id)?.dispose(); terminals.delete(id); }
export function closeAllTerminals() { for (const terminal of terminals.values()) terminal.dispose(); terminals.clear(); }
