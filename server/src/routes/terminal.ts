import type { FastifyInstance } from "fastify";
import type { TerminalClientFrame, TerminalServerFrame } from "@remote-cc/shared";
import { deviceFromRequest } from "../auth.ts";
import { terminalFor, closeAllTerminals, type InteractiveTerminal } from "../shell/terminal.ts";
import { armLiveness } from "../ws-liveness.ts";

export function terminalSize(cols: unknown, rows: unknown) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 20 || Number(cols) > 300 || Number(rows) < 5 || Number(rows) > 120) throw new Error("终端尺寸无效");
  return { cols: Number(cols), rows: Number(rows) };
}
export async function terminalRoutes(app: FastifyInstance) {
  app.addHook("onClose", async () => closeAllTerminals());
  app.get("/api/terminal", { websocket: true }, (socket, req) => {
    const device = deviceFromRequest(req);
    if (!device) { socket.close(1008); return; }
    const disarm = armLiveness(socket);
    let terminal: InteractiveTerminal | null = null, detach: (() => void) | null = null;
    let queue = Promise.resolve(), closed = false, checkedAt = Date.now();
    const send = (frame: TerminalServerFrame) => {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, "请重新连接终端"); return; }
      socket.send(JSON.stringify(frame));
    };
    socket.on("close", () => { closed = true; detach?.(); disarm(); });
    socket.on("error", () => { closed = true; detach?.(); disarm(); });
    socket.on("message", (raw: Buffer) => {
      if (raw.length > 100000) { socket.close(1009); return; }
      let frame: TerminalClientFrame; try { frame = JSON.parse(raw.toString()); } catch { return; }
      queue = queue.then(async () => {
        if (closed) return;
        if (Date.now() - checkedAt > 5000) { checkedAt = Date.now(); if (!deviceFromRequest(req)) { socket.close(1008); return; } }
        if (frame.t === "terminal_open") {
          const size = terminalSize(frame.cols, frame.rows);
          detach?.();
          terminal = terminalFor(device.id, size.cols, size.rows, frame.fresh === true);
          // Subscribe before serializing. Snapshot seq lets the client discard
          // older data and retain any output emitted during snapshot creation.
          detach = terminal.subscribe(send);
          const snapshot = await terminal.snapshot();
          if (!closed) { send(snapshot); terminal.resize(size.cols, size.rows); }
        } else if (frame.t === "terminal_input") {
          if (!terminal || frame.id !== terminal.id) throw new Error("终端连接已变化，请重新连接");
          if (typeof frame.data !== "string" || frame.data.length > 65536) throw new Error("输入过长，请分段粘贴");
          terminal.input(frame.data);
        } else if (frame.t === "terminal_resize") {
          if (!terminal || frame.id !== terminal.id) return;
          const size = terminalSize(frame.cols, frame.rows); terminal.resize(size.cols, size.rows);
        }
      }).catch(error => send({ t: "terminal_error", message: error instanceof Error ? error.message : "终端连接失败" }));
    });
  });
}
