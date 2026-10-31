import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { Api } from "../api";
import type { TerminalClientFrame, TerminalServerFrame } from "../shared";

export function useTerminal(api: Api, render: (frame: TerminalServerFrame) => void) {
  const [connected, setConnected] = useState(false), [running, setRunning] = useState(false), [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const ws = useRef<WebSocket | null>(null), id = useRef<string | null>(null), output = useRef(render);
  const dimensions = useRef({ cols: 80, rows: 24 }), wanted = useRef(false), mounted = useRef(true);
  const retries = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | null>(null), connect = useRef<() => void>(() => {});
  output.current = render;
  const send = useCallback((frame: TerminalClientFrame) => {
    if (ws.current?.readyState !== 1) return false;
    ws.current.send(JSON.stringify(frame)); return true;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const open = () => {
      if (!mounted.current || !wanted.current || AppState.currentState !== "active" || ws.current) return;
      const socket = new WebSocket(api.terminalUrl()); ws.current = socket;
      socket.onopen = () => { if (ws.current === socket) send({ t: "terminal_open", ...dimensions.current }); };
      socket.onmessage = event => {
        if (ws.current !== socket || !mounted.current) return;
        let frame: TerminalServerFrame; try { frame = JSON.parse(event.data); } catch { return; }
        if (frame.t === "terminal_state") { id.current = frame.id; retries.current = 0; setConnected(true); setRunning(frame.running); setExitCode(frame.exitCode); setError(null); }
        if (frame.t === "terminal_exit") { setRunning(false); setExitCode(frame.exitCode); }
        if (frame.t === "terminal_error") setError(frame.message);
        output.current(frame);
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (ws.current !== socket) return;
        ws.current = null; id.current = null;
        if (!mounted.current) return;
        setConnected(false);
        timer.current = setTimeout(open, Math.min(10000, 500 * 2 ** retries.current++));
      };
    };
    connect.current = open; if (wanted.current) open();
    const sub = AppState.addEventListener("change", state => {
      if (state === "active") open();
      else { const socket = ws.current; ws.current = null; id.current = null; socket?.close(); setConnected(false); }
    });
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); sub.remove(); const socket = ws.current; ws.current = null; socket?.close(); };
  }, [api, send]);
  const ready = (cols: number, rows: number) => { dimensions.current = { cols, rows }; wanted.current = true; if (ws.current?.readyState === 1) send({ t: "terminal_open", cols, rows }); else connect.current(); };
  const input = (data: string) => {
    if (!id.current || !send({ t: "terminal_input", id: id.current, data })) setError("终端未连接，输入未发送");
  };
  const resize = (cols: number, rows: number) => { dimensions.current = { cols, rows }; if (id.current) send({ t: "terminal_resize", id: id.current, cols, rows }); };
  const restart = () => { if (!send({ t: "terminal_open", ...dimensions.current, fresh: true })) connect.current(); };
  return { connected, running, exitCode, error, ready, input, resize, restart };
}
