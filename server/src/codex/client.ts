import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 与 **Codex 的 app-server** 说话的那一层。
 *
 * ## 为什么是 stdio,而不是那个 daemon
 *
 * `codex app-server`(不带子命令)直接在 **stdio** 上跑服务,一行一个 JSON(JSONL)。
 * 而 `codex app-server proxy` 代理的是 **daemon 的控制 socket**,不是这套 RPC ——
 * 拿 RPC 去喂它只会静默无响应,最后连接被对端关掉(实测 `os error 10054`)。
 * 这条弯路走过了,别重走。
 *
 * 而且**必须先握手**(`initialize` + `initialized`),否则任何请求都会被回
 * `{"error":{"code":-32600,"message":"Not initialized"}}`(这条倒是很友好,照做就行)。
 *
 * ## 为什么常驻一个子进程
 *
 * 起进程 + 握手要几百毫秒,而额度这种读操作要能一点就出。所以这里维持**一条**长连接,
 * 死了自己重起。它是后端的子进程 —— 于是 `restart-backend.ps1` 的 `Stop-Descendants`
 * 会连它一起收掉,不会留孤儿。
 *
 * ## ⚠️ 依赖
 *
 * 需要**独立的 Codex CLI**:`npm i -g @openai/codex`。桌面端自带的那个 `codex.exe`
 * 起不了 app-server(它会说 "no complete local package")。找不到时这里给一句人话,
 * 而不是让调用方收到一个 ENOENT。
 */

/** 一次 RPC 的默认超时。额度那一步背后有网络往返,给得比本地调用宽 */
const CALL_TIMEOUT_MS = Number(process.env.REMOTE_CC_CODEX_TIMEOUT_MS ?? 20_000);
const INIT_TIMEOUT_MS = 20_000;

export interface CodexCallError {
  code: number;
  message: string;
}

/**
 * 服务端**问我们**的处理器(审批)。返回的东西会作为 `result` 回包;
 * 抛异常则回一个 JSON-RPC error。
 */
export type CodexRequestHandler = (method: string, params: unknown) => Promise<unknown>;

/** 服务端**告诉我们**的处理器(流式增量、turn 结束…)。没有回应可言 */
export type CodexNotificationHandler = (method: string, params: unknown) => void;

/** 把 Codex 的错误回包变成一句人话 */
export function describeCallError(err: CodexCallError | undefined): string {
  if (!err) return "未知错误";
  return err.message || `Codex 返回了错误码 ${err.code}`;
}

/**
 * 把一个命令名 / 路径解析成"能 spawn 的东西"。**找不到返回 null。**
 *
 * 带路径的写法必须真的存在;不带的走 PATH。Windows 上还要认 `.exe/.cmd/.bat`
 * (Node 的 `spawn` **不做 PATHEXT 解析** —— 只有让 shell 去解析它才认,而那正是
 * 下面要躲开的东西)。
 */
function resolveCommand(cmd: string): { command: string; shell: boolean } | null {
  const isScript = (p: string) => /\.(cmd|bat)$/i.test(p);

  if (/[\\/]/.test(cmd) || path.isAbsolute(cmd)) {
    return fs.existsSync(cmd) ? { command: cmd, shell: isScript(cmd) } : null;
  }

  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(candidate)) return { command: candidate, shell: isScript(candidate) };
      } catch {
        // 这个目录读不了(权限、拔掉的盘)—— 当它没有
      }
    }
  }
  return null;
}

/**
 * 找到 codex 可执行文件。
 *
 * ⚠️ **找不到时返回 `null`,而不是"返回一个名字 + `shell: true` 让 cmd.exe 去找"**
 * (2026-10-13 改的,别改回去)。那条兜底看着无害,实际是**全仓唯一能把整个后端打死
 * 的一条路**:`spawn(名字, …, { shell: true })` 起的是 cmd.exe,命令不存在时它几毫秒
 * 就退出;而写进那条 stdin 的字节先**缓冲在流里**,等 flush 才真下到句柄 —— 那时对端
 * 已经没了。详见 `write()` 与 `start()` 里 stdin 那个监听器。
 *
 * 现在:先在 PATH 里**确认它真的在**,确认真不了就**一个进程都不起**,直接一句人话。
 */
export function resolveCodexBin(): { command: string; shell: boolean } | null {
  const override = process.env.REMOTE_CC_CODEX_BIN?.trim() || process.env.CODEX_BIN?.trim();
  if (override) return resolveCommand(override);

  // npm 全局装的那个是 **`.cmd` 垫片**,而真实的 exe 在包内按平台分的目录里,
  // 版本号在路径中,所以用 readdir 而不是写死:
  //     %APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-<平台>\vendor\<目标>\bin\codex.exe
  //
  // ⚠️ 那个平台包**可能被 npm 收进 `@openai/` 那一层,也可能直接摊在 node_modules 下** ——
  // 只往下走一级的写法(原来那样)在 0.162.1 这个布局上必然找不到,于是**每次都静默掉到
  // cmd.exe 兜底**,而那正是把后端打死的那条路。所以这里两层都摊开。
  const npmRoot = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "node_modules");
  const binName = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates: string[] = [];
  try {
    for (const entry of fs.readdirSync(npmRoot)) {
      const p = path.join(npmRoot, entry);
      candidates.push(p);
      if (!entry.startsWith("@")) continue;
      try {
        for (const sub of fs.readdirSync(p)) candidates.push(path.join(p, sub));
      } catch {
        // 这一层读不了(权限)—— 当它没有
      }
    }
  } catch {
    // 包本身没装 —— 落到 PATH 那一步
  }

  for (const root of candidates) {
    const vendorDir = path.join(root, "vendor");
    if (!fs.existsSync(vendorDir)) continue;
    try {
      for (const target of fs.readdirSync(vendorDir)) {
        const exe = path.join(vendorDir, target, "bin", binName);
        if (fs.existsSync(exe)) return { command: exe, shell: false };
      }
    } catch {
      // 同上
    }
  }

  // 兜底:PATH 上的垫片(可能是别的包管理器装的)
  return resolveCommand(process.platform === "win32" ? "codex" : "codex");
}

/** 给"找不到 / 起不来"用的那句话 —— 要让使用者知道**该做什么** */
export function codexMissingHint(): string {
  return (
    "没找到可用的 Codex CLI。装一个: npm i -g @openai/codex —— " +
    "注意 Codex 桌面端自带的那个 codex.exe 不算(它起不了 app-server)。" +
    "装在别处的话,用 REMOTE_CC_CODEX_BIN 指过去。"
  );
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class CodexClient {
  private child: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** 正在启动中的那一次,避免并发调用各起一个进程 */
  private starting: Promise<void> | null = null;
  /** 上一次失败的原因 —— 免得每次请求都去重试一个起不来的进程 */
  private lastFailure: string | null = null;
  private lastFailureAt = 0;

  /** 失败后多久才允许再试。起不来多半是"没装",别每 20 秒就去戳一次 */
  private static readonly RETRY_AFTER_MS = 60_000;

  /** 服务端问我们的处理器(审批)。**同一时刻只留一个** —— 只有会话层会挂 */
  private requestHandler: CodexRequestHandler | null = null;
  private notificationHandlers = new Set<CodexNotificationHandler>();

  /**
   * 挂上「服务端问我们」的处理器。审批就是这一类。
   *
   * ⚠️ **没有处理器时必须回一个错误**(见 `answer`),不能装作没看见 ——
   * 对面在等这个 id 的回包,不回就是**永远卡在等**,而它看起来只是"没反应"。
   */
  onRequest(handler: CodexRequestHandler | null): void {
    this.requestHandler = handler;
  }

  /**
   * 挂上「服务端告诉我们」的处理器(`item/agentMessage/delta`、`turn/completed`…)。
   * 返回一个取消函数。
   */
  onNotification(handler: CodexNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  private write(msg: unknown): void {
    const child = this.child;
    // 已经退出的子进程不再写 —— 这一句挡掉的是"exit 事件还没派发到"的那个窗口
    // (真正的兜底是 `start()` 里挂在 stdin 上的那个 error 监听器)
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private onLine(line: string): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: CodexCallError };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 的一行(日志之类)直接忽略
    }

    // ---- 没有 id:通知 ----
    if (msg.id === undefined) {
      if (msg.method) {
        for (const h of this.notificationHandlers) h(msg.method, msg.params ?? null);
      }
      return;
    }

    // ---- id 对得上我们发出去的:那是回应 ----
    const p = this.pending.get(msg.id);
    if (p) {
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(describeCallError(msg.error)), { codexError: msg.error }));
      else p.resolve(msg.result);
      return;
    }

    /**
     * ---- id 对不上:**是服务端在问我们** ----
     *
     * ⚠️ 这一段原来**根本不存在** —— 那时对所有"不认识的 id"直接 `return` 丢掉。
     * 而 Codex 的审批请求正是长这样(id 由对面生成),于是审批会被静默吃掉:
     * 手机上什么都看不到,那个 turn 永远卡在等审批上。
     */
    if (msg.method) void this.answer(msg.id, msg.method, msg.params ?? null);
  }

  private async answer(id: number, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandler;
    if (!handler) {
      // 回一个"方法没实现"。**必须有这一句**:不回的话对面会一直等。
      this.write({ id, error: { code: -32601, message: `remote-cc 没有处理 ${method} 的处理器` } });
      return;
    }
    try {
      this.write({ id, result: await handler(method, params) });
    } catch (err) {
      this.write({ id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private async start(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const bin = resolveCodexBin();
      // 起不来就**一个进程都不起** —— 返回 null 等于"这台机器上没有可用的 codex",
      // 这时候起 cmd.exe 去找一个不存在的名字,只会换来一条把后端打死的 EPIPE。
      if (!bin) throw new Error(codexMissingHint());

      const child = spawn(bin.command, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: bin.shell,
      });
      this.child = child;

      /**
       * ⚠️ **这一行是保命的,别删。**
       *
       * 子进程死掉时,那条 stdin 管道就是个断了口的管子 —— 而 `write()` 里那笔写往往
       * 还**缓冲在流里**(管道刚建好、还没就绪),要等 flush 才真下到句柄。于是
       * 「子进程已经没了」这件事会以 `write EPIPE` 的形式**从这个 socket 上冒出来**。
       * 没有这个监听器时,`node:events` 会把它**直接抛出**:不是 503、不是日志,
       * 而是**整个后端进程当场退出** —— 2026-10-11 19:00 与 2026-10-13 19:20 各一次,
       * 手机上看到的只是"连不上",要等 watchdog 最多 5 分钟才拉回来。
       *
       * 复现它的关键是要**同时**占住事件循环(flush 才会被推迟到子进程死之后)——
       * 而 `/api/sessions`、`/api/usage` 都是**同步** SQLite 查询,天然会占住。
       * 判据见 `scripts/probe-codex-epipe-race.mjs`:不挂这一行 6/6 必崩,挂了 6/6 全活。
       */
      child.stdin?.on("error", (err) => this.died(child, `stdin 出错(${(err as Error).message})`));

      child.stdout?.on("data", (chunk: Buffer) => {
        this.buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line) this.onLine(line);
        }
      });

      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });

      child.on("error", (err) => this.died(child, `起不来:${err.message}`));
      child.on("exit", (code) =>
        this.died(child, `退出了(code=${code})${stderr ? ` — ${stderr.trim().slice(0, 300)}` : ""}`),
      );

      // 没等到它就绪就发请求会被回 "Not initialized",所以这里同步握完手再交出去
      await this.handshake();
      this.lastFailure = null;
    })()
      .catch((err: unknown) => {
        this.died(this.child, err instanceof Error ? err.message : String(err));
        throw err;
      })
      .finally(() => {
        this.starting = null;
      });

    return this.starting;
  }

  /**
   * 子进程没了:把在等的请求全部失败掉,并记下原因。
   *
   * ⚠️ `child` 这个参数是**必须的**(2026-10-13 加):`exit` / `error` / stdin 三处都会
   * 调它,而它们的派发**可能迟到**。没有这层身份校验时,一个已经死掉的旧子进程晚到的
   * `exit` 会把**刚起来的新子进程**一起抹掉 —— 表现是"codex 时好时坏"。
   */
  private died(child: ChildProcess | null, reason: string): void {
    if (!child || this.child !== child) return;
    this.lastFailure = reason;
    this.lastFailureAt = Date.now();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Codex app-server ${reason}`));
    }
    this.pending.clear();
    this.child = null;
    this.buf = "";
  }

  private handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex app-server 握手超时"));
      }, INIT_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: () => resolve(),
        reject: (e) => reject(e),
        timer,
      });
      this.write({ id, method: "initialize", params: { clientInfo: { name: "remote-cc", version: "0" } } });
      // `initialized` 是个**通知**(没有 id,也就没有回应),发出去就算完
      this.write({ method: "initialized", params: null });
    });
  }

  async call<T = unknown>(method: string, params: unknown = null): Promise<T> {
    // 刚失败过就别再戳了 —— 起不来的多半是"没装",60 秒内不重试
    if (!this.child && this.lastFailure && Date.now() - this.lastFailureAt < CodexClient.RETRY_AFTER_MS) {
      throw new Error(this.lastFailure);
    }

    await this.start();

    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时(${CALL_TIMEOUT_MS}ms)`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.write({ id, method, params });
    });
  }

  /** 尽力收尾。进程被杀时这里可能来不及跑,那就留给 `restart-backend.ps1` 的连带收后代 */
  stop(): void {
    try {
      this.child?.stdin?.end();
      this.child?.kill();
    } catch {
      // 已经死了
    }
    this.child = null;
  }
}

let singleton: CodexClient | null = null;

export function codexClient(): CodexClient {
  if (!singleton) {
    singleton = new CodexClient();
    // 后端退出时尽量把它带走。没有这条的话会留下一个空转的 app-server
    // (它不监听端口,危害有限,但没必要)。
    process.once("exit", () => singleton?.stop());
  }
  return singleton;
}
