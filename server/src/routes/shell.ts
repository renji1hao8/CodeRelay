import type { FastifyInstance } from "fastify";
import { SHELL_TAIL_CHARS, type ClientFrame, type ServerFrame, type ShellChunk } from "@remote-cc/shared";
import { deviceFromRequest } from "../auth.ts";
import { resolvePwsh } from "../shell/pwsh.ts";
import {
  closeStdin,
  defaultCwd,
  jobChunks,
  jobsOfDevice,
  ownsJob,
  setShellHost,
  shellHistory,
  startShell,
  stopJob,
  writeStdin,
} from "../shell/jobs.ts";

/**
 * **命令框**那条通道(`GET /api/shell`,一条 WebSocket)。
 *
 * ## 它是什么、不是什么
 *
 * 它是**使用者自己的手**伸到电脑上,不是在跑 agent 的工具。他的原话:
 * 「为了实现一些必须由我来跑,agent 不能或不应该代替我实现的操作」。所以这里
 * **不白名单、不拦内容**(自由执行),但要**全程留痕**(见 jobs.ts 里的 recordAudit)。
 *
 * ## 安全边界
 *
 * ⚠️ **不放进 `PUBLIC_PATHS`。** 隧道下 nginx 从 127.0.0.1 转发,**任何公网请求在后端
 * 眼里也是环回** —— 免 token 等于把一台能跑任意命令的 shell 挂在公网上。
 * token 走 `?token=`(WebSocket 加不了自定义头,这是既有的做法,见 `auth.ts::deviceFromRequest`)。
 *
 * ⚠️ 这条通道**能杀掉后端自己**(`Stop-Process -Name node`)而且没有任何东西会自动把它
 * 拉回来(`bootstrap.ps1` 只在登录时跑)。这条**不靠代码兜**,靠界面上那句常驻提示
 * 和文档里写清楚:要停某条命令用界面上的打断,别对着进程名开火。
 *
 * ## 和提权那条路的关系
 *
 * **不要混。** 要管理员权限的动作仍然走 `deploy/elevate.ps1` 那条红卡路 —— UAC 框在
 * Windows 的 secure desktop 上,从这条通道里永远看不到它,只会得到 `ERROR_CANCELLED`。
 */
/** 快照帧的**具体**类型(不是 `ServerFrame` 那个大联合)—— 拼装时要用它的字段 */
type SnapshotFrame = Extract<ServerFrame, { t: "shell_snapshot" }>;

export async function shellRoutes(app: FastifyInstance): Promise<void> {
  /** 所有连着的命令流。用一个集合而不是按作业分组:一帧输出要发给每一个开着这一屏的人 */
  const subscribers = new Set<(frame: ServerFrame) => void>();

  setShellHost({
    onChunk(jobId, chunk) {
      broadcast({ t: "shell_output", jobId, chunk });
    },
    onJob(job) {
      broadcast(job.running ? { t: "shell_started", job } : { t: "shell_exit", job });
    },
    onError(jobId, message, recoverable) {
      broadcast({ t: "shell_error", jobId, message, recoverable });
    },
  });

  function broadcast(frame: ServerFrame) {
    for (const send of subscribers) {
      try {
        send(frame);
      } catch {
        /* 连接已断,由 close 事件清理 */
      }
    }
  }

  /**
   * 快照里那份输出最多给这么长。
   *
   * 超了就从头上截 —— 截了 `seq` 就出现断档,而 App 那边的 `mergeShellChunks`
   * **接不上就整段换**,所以截断不会造成"两段拼一起、每行两遍"。
   */
  function tailOf(jobId: string): ShellChunk[] {
    const all = jobChunks(jobId);
    let chars = 0;
    let from = all.length;
    for (let i = all.length - 1; i >= 0; i--) {
      chars += all[i]!.text.length;
      if (chars > SHELL_TAIL_CHARS) break;
      from = i;
    }
    return all.slice(from);
  }

  function snapshotFor(deviceId: string | null): SnapshotFrame {
    const jobs = jobsOfDevice(deviceId);
    /**
     * 该默认给你看哪一条。
     *
     * ⚠️ **按 `startedAt` 倒序挑,不能拿 `jobs[0]`** —— `jobs` 是 Map 的插入顺序,
     * 也就是"**最老**的那条",而你要看的几乎总是**刚跑的那条**。
     * (`probe-shell-ws.mjs` 第 3 组抓出来的:跑完一条再重连,快照给的是几分钟前
     * 那条 `cmd /c exit 7`,输出当然是空的 —— 而界面上就成了"我的输出不见了"。)
     *
     * 规则:**最新的那条正在跑的**优先,没有正在跑的就给最新的那条。
     */
    const sorted = [...jobs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const active = sorted.find((j) => j.running) ?? sorted[0] ?? null;
    return {
      t: "shell_snapshot",
      jobs,
      jobId: active?.jobId ?? null,
      chunks: active ? tailOf(active.jobId) : [],
      history: shellHistory(),
      pwsh: resolvePwsh(),
    };
  }

  /** 冷启动对齐 / 排障:不带 WebSocket 也能问一句"现在有什么" */
  app.get("/api/shell/jobs", async (req) => {
    const device = deviceFromRequest(req);
    const deviceId = device?.id ?? null;
    return {
      jobs: jobsOfDevice(deviceId),
      history: shellHistory(),
      cwd: defaultCwd(),
      pwsh: resolvePwsh(),
    };
  });

  app.get("/api/shell", { websocket: true }, (socket, req) => {
    const deviceId = deviceFromRequest(req)?.id ?? null;

    const send = (frame: ServerFrame) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(frame));
    };
    subscribers.add(send);

    // 一接上就对齐:作业表 + 那条作业已有的输出 + 命令历史。
    // 命令这边**没有第二份来源**(不像聊天还有 jsonl 历史),所以快照就是回放 ——
    // 也正因如此才不需要聊天那边那套 `replay` 认亲。
    send(snapshotFor(deviceId));

    socket.on("message", (raw: Buffer) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(raw.toString()) as ClientFrame;
      } catch {
        return; // 不是 JSON 就丢,不回错 —— 回了反而可能被拿来刷屏
      }
      void handle(frame);
    });

    socket.on("close", () => {
      subscribers.delete(send);
    });

    async function handle(frame: ClientFrame): Promise<void> {
      switch (frame.t) {
        case "shell_start": {
          if (typeof frame.command !== "string") return;
          const res = await startShell(frame.command, frame.cwd, deviceId);
          if (!res.ok) {
            send({ t: "shell_error", jobId: null, message: res.error, recoverable: true });
            return;
          }
          // `shell_started` 由 jobs 层的 onJob 广播出去(所有订阅者都要知道),这里不补发
          return;
        }
        case "shell_stdin": {
          if (typeof frame.jobId !== "string" || typeof frame.data !== "string") return;
          if (!ownsJob(frame.jobId, deviceId)) {
            send({ t: "shell_error", jobId: frame.jobId, message: "这条命令不是这台设备发起的", recoverable: true });
            return;
          }
          if (!writeStdin(frame.jobId, frame.data, frame.newline !== false)) {
            send({ t: "shell_error", jobId: frame.jobId, message: "那条命令已经不在跑了", recoverable: true });
          }
          return;
        }
        case "shell_eof": {
          if (typeof frame.jobId !== "string") return;
          if (ownsJob(frame.jobId, deviceId)) closeStdin(frame.jobId);
          return;
        }
        case "shell_stop": {
          if (typeof frame.jobId !== "string") return;
          if (!ownsJob(frame.jobId, deviceId)) {
            send({ t: "shell_error", jobId: frame.jobId, message: "这条命令不是这台设备发起的", recoverable: true });
            return;
          }
          await stopJob(frame.jobId);
          return;
        }
        case "shell_attach": {
          if (typeof frame.jobId !== "string") return;
          if (!ownsJob(frame.jobId, deviceId)) return;
          // `t` 不在这里重申 —— 展开的那份已经带着它(重申会被 TS 挡下来,也确实该挡)
          send({ ...snapshotFor(deviceId), jobId: frame.jobId, chunks: tailOf(frame.jobId) });
          return;
        }
        default:
          return;
      }
    }
  });
}
