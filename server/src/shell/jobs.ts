import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import {
  SHELL_COMMAND_MAX,
  SHELL_FLUSH_MS,
  SHELL_HISTORY_MAX,
  SHELL_MAX_JOBS,
  SHELL_MAX_PER_MINUTE,
  SHELL_RING_CHARS,
  SHELL_RING_CHUNKS,
  SHELL_TIMEOUT_MS,
  type ShellChunk,
  type ShellHistoryEntry,
  type ShellJob,
} from "@remote-cc/shared";
import { kvGet, kvSet, recordAudit } from "../db.ts";
import { assertSafe } from "../paths.ts";
import { ByteDecoder, LineAssembler, StderrSplitter, stripAnsi } from "./lines.ts";
import { pwshArgs, pwshEnv, resolvePwsh } from "./pwsh.ts";

/**
 * 命令框的**作业层**:起进程、收输出、编号、环形缓冲、三段式打断、留痕。
 *
 * 一条命令一个 pwsh 进程,**`cd` 不跨命令保留** —— 这正是界面上要有 cwd 输入框的原因。
 * (想做持久会话得有 ConPTY,而那个在 Node 里没有现成的路;这里不假装有。)
 */

const HISTORY_KEY = "shell.history";
const CWD_KEY = "shell.cwd";

/** 往手机上推东西的三个出口。由路由层接上(这一层不认识 WebSocket) */
export interface ShellHost {
  onChunk(jobId: string, chunk: ShellChunk): void;
  onJob(job: ShellJob): void;
  onError(jobId: string | null, message: string, recoverable: boolean): void;
}

let host: ShellHost = { onChunk: () => {}, onJob: () => {}, onError: () => {} };
export function setShellHost(h: ShellHost): void {
  host = h;
}

interface Job {
  jobId: string;
  command: string;
  cwd: string;
  startedAt: string;
  deviceId: string | null;
  child: ChildProcessWithoutNullStreams;
  running: boolean;
  exitCode: number | null;
  stopped: boolean;
  truncated: boolean;
  /** 输出块的环形缓冲。**唯一的那一份来源** —— 命令这边没有 jsonl 那样的第二份 */
  chunks: ShellChunk[];
  ringChars: number;
  /** 下一个要发的编号 */
  nextSeq: number;
  /** out/err 两个解码器(编码是按流判的),但**行组装只有一个**(见 lines.ts 的说明) */
  decOut: ByteDecoder;
  decErr: ByteDecoder;
  asm: LineAssembler;
  flushTimer: ReturnType<typeof setInterval> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  /** stderr 的两副面孔(原始字节 / CLIXML 文档)由它分。见 lines.ts 的说明 */
  errSplit: StderrSplitter;
  /** "跑了很久"那条提示只发一次 */
  announcedTimeout: boolean;
}

const jobs = new Map<string, Job>();

/** 一分钟内的发起时间戳(全设备共享一个窗口 —— 限流是"别把后端打爆",不是按人配额) */
let recentStarts: number[] = [];

/**
 * **已经受理、但还没落到 `jobs` 表里的**条数。
 *
 * ⚠️ 这个计数器不是多余的 —— 少了它,并发上限形同虚设(2026-09-21 被
 * `probe-shell-ws.mjs` 的第 5 组抓出来):`startShell` 里要 `await assertSafe(...)`
 * 校验工作目录,**一 await 就让出**,于是四条同时到达的 `shell_start` 全都**在别人
 * 注册之前**数到了 0 个在跑的作业,四条一起放行。这是典型的 check-then-act。
 * 把"名额定下来"这一步挪到任何 await **之前**,由这个计数器兜住那一段窗口。
 */
let inflight = 0;

function slot(id: string): ShellJob {
  const j = jobs.get(id)!;
  const first = j.chunks[0];
  const last = j.chunks[j.chunks.length - 1];
  return {
    jobId: j.jobId,
    command: j.command,
    cwd: j.cwd,
    startedAt: j.startedAt,
    running: j.running,
    exitCode: j.exitCode,
    stopped: j.stopped,
    truncated: j.truncated,
    seqFrom: first?.seq ?? 0,
    seqTo: last?.seq ?? 0,
  };
}

export function listJobs(): ShellJob[] {
  return [...jobs.values()].map((j) => slot(j.jobId));
}

export function jobChunks(jobId: string): ShellChunk[] {
  return jobs.get(jobId)?.chunks ?? [];
}

export function jobsOfDevice(deviceId: string | null): ShellJob[] {
  return [...jobs.values()].filter((j) => j.deviceId === deviceId).map((j) => slot(j.jobId));
}

/**
 * 这条作业是不是这台设备发起的。
 *
 * ⚠️ 别省:同一个后端可能配了**不止一台**手机。不管的话,另一台能往你正在跑的
 * `ssh` 会话里写 stdin、或者把你的构建打断掉。
 */
export function ownsJob(jobId: string, deviceId: string | null): boolean {
  const j = jobs.get(jobId);
  return j !== undefined && j.deviceId === deviceId;
}

export function defaultCwd(): string {
  return kvGet(CWD_KEY) ?? process.cwd();
}

export function shellHistory(): ShellHistoryEntry[] {
  const raw = kvGet(HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ShellHistoryEntry[]) : [];
  } catch {
    // 读不出来就当没有 —— 历史丢了不致命,别为它把整个界面卡住
    return [];
  }
}

function pushHistory(entry: ShellHistoryEntry): void {
  const next = [entry, ...shellHistory()].slice(0, SHELL_HISTORY_MAX);
  kvSet(HISTORY_KEY, JSON.stringify(next));
}

function rewriteHistory(job: Job): void {
  const list = shellHistory();
  const at = list.findIndex((h) => h.command === job.command && h.at === job.startedAt);
  if (at < 0) return;
  list[at] = { ...list[at]!, exitCode: job.exitCode };
  kvSet(HISTORY_KEY, JSON.stringify(list));
}

/** 越限就从头上丢块。丢过就把 `truncated` 立起来 —— 界面要明说"更早的输出没留存" */
function trimRing(job: Job): void {
  while (
    job.chunks.length > SHELL_RING_CHUNKS ||
    (job.ringChars > SHELL_RING_CHARS && job.chunks.length > 1)
  ) {
    const gone = job.chunks.shift();
    if (!gone) break;
    job.ringChars -= gone.text.length;
    job.truncated = true;
  }
}

function emit(job: Job, text: string, stream: "out" | "err"): void {
  job.asm.push(text, stream);
}

/** 把组装器里攒下的块取走、编号、进环形缓冲、推给手机 */
function drain(job: Job): void {
  const pieces = job.asm.flush();
  for (const p of pieces) {
    if (p.text.length === 0 && !p.partial) continue; // 空块没有信息量
    const chunk: ShellChunk = { seq: job.nextSeq++, stream: p.stream, text: p.text, partial: p.partial };
    job.chunks.push(chunk);
    job.ringChars += chunk.text.length;
    trimRing(job);
    host.onChunk(job.jobId, chunk);
  }
}

function finishJob(job: Job, code: number | null, stopped: boolean): void {
  if (!job.running) return;
  job.running = false;
  job.exitCode = stopped ? null : code;
  job.stopped = stopped;

  if (job.flushTimer) clearInterval(job.flushTimer);
  job.flushTimer = null;
  if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
  job.timeoutTimer = null;

  // stderr 攒着的那份(CLIXML 文档)到这一步才知道全部内容,解包之后按 err 推出去
  const errTail = job.errSplit.finish();
  if (errTail) emit(job, errTail, "err");
  emit(job, job.decOut.flush(), "out");
  emit(job, job.decErr.flush(), "err");
  for (const p of job.asm.finish("out")) {
    const chunk: ShellChunk = { seq: job.nextSeq++, stream: p.stream, text: p.text, partial: p.partial };
    job.chunks.push(chunk);
    job.ringChars += chunk.text.length;
    trimRing(job);
    host.onChunk(job.jobId, chunk);
  }

  rewriteHistory(job);
  recordAudit(
    job.deviceId,
    "shell.exit",
    job.jobId,
    stopped ? "denied" : job.exitCode === 0 ? "ok" : "error",
    `退出码 ${job.exitCode ?? "(被打断,无退出码)"},耗时 ${Date.now() - Date.parse(job.startedAt)}ms`,
  );
  host.onJob(slot(job.jobId));

  /**
   * 作业表不能无限长。
   *
   * 跑完的那几条留着是**有意义的**(刚跑完还盯着屏幕,关掉会话再回来还要能看),
   * 但机器连着开几天就是几百条、每条都带着最多 1MB 的环形缓冲。留最近 20 条,
   * 从最老的已结束那条开始丢。
   */
  if (jobs.size > 20) {
    for (const [id, j] of jobs) {
      if (jobs.size <= 20) break;
      if (!j.running) jobs.delete(id);
    }
  }
}

function onStderr(job: Job, text: string): void {
  const now = job.errSplit.push(text);
  if (now) emit(job, stripAnsi(now), "err");
}

export type StartResult = { ok: true; job: ShellJob } | { ok: false; code: number; error: string };

/**
 * 起一条命令。
 *
 * ⚠️ 权限是"**自由执行 + 审计留痕**"(使用者的选择):不白名单、不拦内容,但
 * **受理的那一刻就记一条审计** —— 中途卡死、被打断、后端重启冲掉,才是最该留痕的,
 * 等结束再记就来不及了。
 */
export async function startShell(
  command: string,
  cwd: string | undefined,
  deviceId: string | null,
): Promise<StartResult> {
  const cmd = command.trim();
  if (!cmd) return { ok: false, code: 400, error: "命令是空的" };
  if (cmd.length > SHELL_COMMAND_MAX) {
    return { ok: false, code: 400, error: `命令太长了(上限 ${SHELL_COMMAND_MAX} 字节,现在 ${cmd.length})` };
  }

  const exe = resolvePwsh();
  if (!exe) {
    return {
      ok: false,
      code: 503,
      error: "找不到 pwsh 7 —— 装一个,或者用环境变量 REMOTE_CC_PWSH 指定绝对路径",
    };
  }

  /**
   * ⚠️ **并发与限流都在任何一个 `await` 之前判、并且当场把名额占掉。**
   * 见上面 `inflight` 那段说明 —— 挪到 await 之后就是一个能被并发打穿的检查。
   */
  const running = [...jobs.values()].filter((j) => j.running).length + inflight;
  if (running >= SHELL_MAX_JOBS) {
    recordAudit(deviceId, "shell.run", null, "denied", `并发已满(${SHELL_MAX_JOBS})`);
    return { ok: false, code: 429, error: `同时最多跑 ${SHELL_MAX_JOBS} 条,先等一条跑完或打断它` };
  }
  const now = Date.now();
  recentStarts = recentStarts.filter((t) => now - t < 60_000);
  if (recentStarts.length >= SHELL_MAX_PER_MINUTE) {
    recordAudit(deviceId, "shell.run", null, "denied", `一分钟内超过 ${SHELL_MAX_PER_MINUTE} 次`);
    return { ok: false, code: 429, error: `一分钟最多发 ${SHELL_MAX_PER_MINUTE} 条 —— 这不是配额,是防止死循环把后端打爆` };
  }
  recentStarts.push(now);
  inflight += 1;

  try {
    // cwd 走**文件页那套白名单校验**(paths.ts),不自己写一遍 —— 命令框能跑任意命令,
    // 但"在哪个目录跑"仍然只能是那些根底下的地方
    const want = cwd?.trim() || defaultCwd();
    let safeCwd: string;
    try {
      safeCwd = await assertSafe(want);
    } catch (err) {
      return { ok: false, code: 403, error: `工作目录不能用:${err instanceof Error ? err.message : String(err)}` };
    }

    const jobId = `sh_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const child = spawn(exe, pwshArgs(), {
      cwd: safeCwd,
      env: { ...pwshEnv(), RC_CMD: cmd },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    const job: Job = {
      jobId,
      command: cmd,
      cwd: safeCwd,
      startedAt: new Date(now).toISOString(),
      deviceId,
      child,
      running: true,
      exitCode: null,
      stopped: false,
      truncated: false,
      chunks: [],
      ringChars: 0,
      nextSeq: 1,
      decOut: new ByteDecoder(),
      decErr: new ByteDecoder(),
      asm: new LineAssembler(),
      flushTimer: null,
      timeoutTimer: null,
      errSplit: new StderrSplitter(),
      announcedTimeout: false,
    };
    jobs.set(jobId, job);
    kvSet(CWD_KEY, safeCwd);

    child.stdout.on("data", (buf: Buffer) => {
      emit(job, stripAnsi(job.decOut.push(buf)), "out");
    });
    child.stderr.on("data", (buf: Buffer) => {
      onStderr(job, job.decErr.push(buf));
    });
    child.on("error", (err) => {
      host.onError(jobId, `起不了 pwsh:${err.message}`, false);
      finishJob(job, null, false);
    });
    child.on("close", (code) => {
      finishJob(job, code, job.stopped);
    });

    job.flushTimer = setInterval(() => drain(job), SHELL_FLUSH_MS);
    job.timeoutTimer = setTimeout(() => {
      if (!job.running || job.announcedTimeout) return;
      job.announcedTimeout = true;
      // ⚠️ **只提示,不杀** —— 长构建真的会跑很久,到点把它掐掉是在帮倒忙
      host.onError(
        jobId,
        `这条已经跑了 ${Math.round(SHELL_TIMEOUT_MS / 60_000)} 分钟,还在跑(不会自动杀,要停请按打断)`,
        true,
      );
    }, SHELL_TIMEOUT_MS);

    recordAudit(deviceId, "shell.run", jobId, "ok", `${safeCwd} $ ${cmd.slice(0, 300)}`);
    pushHistory({ command: cmd, cwd: safeCwd, at: job.startedAt, exitCode: null });
    const started = slot(jobId);
    host.onJob(started);
    return { ok: true, job: started };
  } finally {
    inflight -= 1;
  }
}

/** 往正在跑的那条命令的 stdin 写。⚠️ **绝不记内容** —— ssh 密码、token 都从这儿过 */
export function writeStdin(jobId: string, data: string, newline: boolean): boolean {
  const job = jobs.get(jobId);
  if (!job?.running || !job.child.stdin.writable) return false;
  job.child.stdin.write(newline ? `${data}\n` : data);
  recordAudit(job.deviceId, "shell.stdin", jobId, "ok", `${data.length} 字节(内容不记)`);
  return true;
}

/** 关掉 stdin = Ctrl+D。不少 CLI 把它当"我说完了,收工" */
export function closeStdin(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job?.running) return false;
  job.child.stdin.end();
  recordAudit(job.deviceId, "shell.stdin", jobId, "ok", "关了 stdin(Ctrl+D)");
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 那个 PID 现在还是不是 pwsh。
 *
 * ⚠️ 不能省:PID 会被复用。刚 `taskkill /T /F` 掉一个 PID,系统转眼可能把它发给
 * 别的进程 —— 那时再 `/T /F` 一次就是**对着不相干的进程树开枪**。
 * (`restart-backend.ps1` 里"按监听端口反查 PID、不按名字杀"是同一条纪律。)
 */
function stillPwsh(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "tasklist.exe",
      ["/FI", `PID eq ${pid}`, "/FI", "IMAGENAME eq pwsh.exe", "/NH"],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(/pwsh\.exe/i.test(stdout));
      },
    );
  });
}

function taskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    execFile("taskkill.exe", args, { windowsHide: true }, () => resolve());
  });
}

/**
 * **打断**。手机上那个键 = Ctrl+C,但实现上差得远,所以分三段:
 *
 * 1. 先关 stdin 等 300ms —— 不少 CLI 把 EOF 当"收工",能干净退出最好;
 * 2. `taskkill /T`(不带 /F)等 700ms —— `/T` 走**当时的父子关系**把整棵树带上。
 *    这一条是关键:Node 的 `child.kill()` 在 Windows 上是 TerminateProcess,
 *    **不杀孙进程** —— 直接 kill 会留下 `cmd` / `npm` 那层孤儿继续占着端口和文件;
 * 3. `taskkill /T /F` 等 300ms,还不死才 `child.kill()`。
 *
 * ⚠️ **它不是真 Ctrl+C**:那是给进程组发控制台事件,而我们的 stdio 全是管道、
 * 没有同一个控制台进程组可发。所以命令**一行清理代码都跑不到** —— git 会留下
 * `index.lock`、写文件留下半截、临时目录残留。能力等价、语义不等价,界面上要写清楚。
 */
export async function stopJob(jobId: string): Promise<boolean> {
  const job = jobs.get(jobId);
  if (!job?.running) return false;
  job.stopped = true;
  recordAudit(job.deviceId, "shell.stop", jobId, "ok", job.command.slice(0, 200));

  const pid = job.child.pid;
  try {
    job.child.stdin.end();
  } catch {
    /* 已经关了 */
  }
  await sleep(300);
  if (!job.running || pid === undefined) return true;

  if (await stillPwsh(pid)) await taskkill(pid, false);
  await sleep(700);
  if (!job.running) return true;

  if (await stillPwsh(pid)) await taskkill(pid, true);
  await sleep(300);
  if (!job.running) return true;

  try {
    job.child.kill();
  } catch {
    /* 已经没了 */
  }
  return true;
}

/**
 * 后端自己在退出(或被重启脚本收掉)时,把在跑的命令一起收干净。
 *
 * ⚠️ 不能让它们变成孤儿:那些是 `pwsh` + 它名下的整棵树(可能是 `npm`、`msbuild`),
 * 留一堆下来会继续占端口、占文件锁,而使用者只会看到"手机上说没在跑,电脑上还在转"。
 */
export function stopAllJobs(): void {
  for (const job of jobs.values()) {
    if (!job.running) continue;
    job.stopped = true;
    try {
      job.child.stdin.end();
    } catch {
      /* 忽略 */
    }
    try {
      // 后端要走了,没时间走三段式 —— 直接上最狠的那一档
      if (job.child.pid !== undefined) void taskkill(job.child.pid, true);
    } catch {
      /* 忽略 */
    }
  }
}
