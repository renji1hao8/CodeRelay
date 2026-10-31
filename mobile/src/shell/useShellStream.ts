import { useCallback, useEffect, useRef, useState } from "react";
import {
  mergeShellChunks,
  type ClientFrame,
  type ServerFrame,
  type ShellChunk,
  type ShellHistoryEntry,
  type ShellJob,
} from "../shared";
import type { Api } from "../api";

/**
 * **命令框**那条流的状态机(`/api/shell`)。
 *
 * 比 `useSessionStream` 简单得多,因为这边**没有第二份来源**:聊天那边要处理
 * "重连补发的帧和手上的历史重叠"(见根 CLAUDE.md 坑 40),而命令这边只有后端一个
 * 环形缓冲 —— 所以快照就是回放,`mergeShellChunks` 一算就完事,不需要认亲。
 *
 * 三件事要守住:
 *
 * 1. **重连要能自己好**(和会话那条一样:网络抖一下不该让这一屏废掉);
 * 2. **切走再回来要接得上**:命令还在跑,回来看到的必须是完整的当前行
 *    (`partial` 语义由 `renderShellChunks` 负责,这里只管块齐不齐);
 * 3. **发送失败要明说**,别静默吞掉 —— 这条纪律是第 2 条需求(ask 卡片点不动)
 *    查出来的,别在这一层又破一次。
 */
export interface ShellState {
  connected: boolean;
  jobs: ShellJob[];
  /** 正在看的那条作业 */
  activeId: string | null;
  /** 那条作业已有的输出(和上面同一个口径) */
  chunks: ShellChunk[];
  history: ShellHistoryEntry[];
  /** pwsh 的路径。**null = 后端找不到 pwsh**,这一屏直接说明白 */
  pwsh: string | null;
  error: string | null;
}

export function useShellStream(api: Api) {
  const [state, setState] = useState<ShellState>({
    connected: false,
    jobs: [],
    activeId: null,
    chunks: [],
    history: [],
    pwsh: null,
    error: null,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const closedRef = useRef(false);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  activeIdRef.current = state.activeId;

  const send = useCallback((frame: ClientFrame): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }, []);

  useEffect(() => {
    closedRef.current = false;

    const connect = () => {
      if (closedRef.current) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(api.shellUrl());
      } catch (err) {
        setState((s) => ({ ...s, error: `连不上命令通道:${String(err)}` }));
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        setState((s) => ({ ...s, connected: true, error: null }));
      };

      ws.onmessage = (ev) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(ev.data)) as ServerFrame;
        } catch {
          return;
        }
        apply(frame);
      };

      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (closedRef.current) return;
        // 退避重连:1s 起、最多 5s。命令可能正在跑,断着的时候什么都看不到
        retryRef.current = Math.min(retryRef.current + 1, 5);
        timerRef.current = setTimeout(connect, retryRef.current * 1000);
      };

      ws.onerror = () => {
        // onclose 一定会跟着来,重连逻辑放那儿,这里不重复
      };
    };

    function apply(frame: ServerFrame) {
      switch (frame.t) {
        case "shell_snapshot": {
          setState((s) => {
            /**
             * ⚠️ 换了作业就**整段换**,别和上一条的揉在一起 —— 它们是两条命令的输出。
             * 同一条才走 `mergeShellChunks`(它自己会判"接得上就补差值、接不上就整段换")。
             */
            const sameJob = s.activeId === frame.jobId;
            return {
              ...s,
              jobs: frame.jobs,
              history: frame.history,
              pwsh: frame.pwsh,
              activeId: frame.jobId ?? null,
              chunks: sameJob ? mergeShellChunks(s.chunks, frame.chunks) : frame.chunks,
            };
          });
          return;
        }
        case "shell_output": {
          if (frame.jobId !== activeIdRef.current) return;
          const chunk = frame.chunk;
          setState((s) => {
            const last = s.chunks[s.chunks.length - 1];
            // 实时帧不会乱序;`seq` 不比手上新就丢掉(重连和实时可能撞上同一块)
            if (last && chunk.seq <= last.seq) return s;
            return { ...s, chunks: [...s.chunks, chunk] };
          });
          return;
        }
        case "shell_started": {
          setState((s) => ({
            ...s,
            jobs: [...s.jobs.filter((j) => j.jobId !== frame.job.jobId), frame.job],
            // 新起的那条自动成为当前这条(你刚按了运行,想看的就是它)
            activeId: frame.job.jobId,
            chunks: s.activeId === frame.job.jobId ? s.chunks : [],
          }));
          return;
        }
        case "shell_exit": {
          setState((s) => ({
            ...s,
            jobs: s.jobs.map((j) => (j.jobId === frame.job.jobId ? frame.job : j)),
          }));
          return;
        }
        case "shell_error": {
          setState((s) => ({ ...s, error: frame.message }));
          return;
        }
        default:
          return;
      }
    }

    connect();
    return () => {
      closedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      try {
        wsRef.current?.close();
      } catch {
        /* 已经断了 */
      }
      wsRef.current = null;
    };
  }, [api]);

  const run = useCallback(
    (command: string, cwd: string) => {
      setState((s) => ({ ...s, error: null, chunks: [] }));
      if (!send({ t: "shell_start", command, cwd: cwd.trim() || undefined })) {
        setState((s) => ({ ...s, error: "没连上电脑,命令没发出去 —— 等一下再试" }));
        return false;
      }
      return true;
    },
    [send],
  );

  const stop = useCallback(
    (jobId: string) => {
      if (!send({ t: "shell_stop", jobId })) {
        setState((s) => ({ ...s, error: "没连上电脑,打断没发出去" }));
      }
    },
    [send],
  );

  const writeStdin = useCallback(
    (jobId: string, data: string, newline = true) => {
      if (!send({ t: "shell_stdin", jobId, data, newline })) {
        setState((s) => ({ ...s, error: "没连上电脑,这一行没发出去" }));
      }
    },
    [send],
  );

  const closeStdin = useCallback(
    (jobId: string) => {
      send({ t: "shell_eof", jobId });
    },
    [send],
  );

  /** 切到另一条作业:要它已有的输出 */
  const attach = useCallback(
    (jobId: string) => {
      setState((s) => ({ ...s, activeId: jobId, chunks: [] }));
      send({ t: "shell_attach", jobId });
    },
    [send],
  );

  const dismissError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  return { ...state, run, stop, writeStdin, closeStdin, attach, dismissError };
}
