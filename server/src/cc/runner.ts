import crypto from "node:crypto";
import type {
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  parseQuestions,
  type ChatBlock,
  type ImageAttachment,
  type PermissionDecision,
  type PermissionMode,
  type ServerFrame,
} from "@remote-cc/shared";
import { blocksFromContent } from "../history/parser.ts";
import { ApprovalBroker, type PendingApproval, type RespondResult } from "./permissions.ts";
import { AsyncQueue } from "./queue.ts";

type SdkPermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/**
 * 我们的四档 → SDK 的四档。
 *
 * ⚠️ `bypass` **故意不映射到 SDK 的 `bypassPermissions`**:那个要求额外打开
 * `allowDangerouslySkipPermissions`,而且一旦打开,**`canUseTool` 就完全不再被调用** ——
 * 而 `AskUserQuestion` 走的正是这条路(它要把答案并进 `updatedInput` 回传)。
 * 关了它,模型就只能自己编一个答案。所以全自动档落到 `acceptEdits`(文件编辑由 CLI
 * 直接放行,省一个来回),剩下的由下面的 canUseTool 一律放行 —— 效果是"什么都不问",
 * 但不误伤问答。
 */
function sdkPermissionMode(mode: PermissionMode): SdkPermissionMode {
  switch (mode) {
    case "readonly":
      return "plan";
    case "acceptEdits":
    case "bypass":
      return "acceptEdits";
    case "ask":
    default:
      return "default";
  }
}

/**
 * Claude Code 的 Bash 工具用的那个 shell —— 报给手机,标在命令卡片上。
 *
 * ⚠️ **它只有一个。** Claude Code 没有"用 PowerShell 跑"这种工具:它只拉起一个 shell
 * (Windows 上固定是 Git for Windows 的 bash,这也是 `CLAUDE_CODE_GIT_BASH_PATH`
 * 存在的意义),而要走到 cmd / pwsh / wsl,唯一的途径是**在命令里显式调**。
 * 所以卡片上标的是"这个 shell",再由 App 看命令的第一个词叠一个「嵌套 xxx」角标。
 */
const SHELL_LABEL = process.platform === "win32" ? "Git Bash" : "bash";

/** 帧日志的两条上限 —— 长回答的 delta 可能有几千帧,不设限就是内存泄漏 */
const FRAME_LOG_MAX = 1200;
const FRAME_LOG_BYTES = 512 * 1024;

export interface CcSessionHooks {
  /** 帧广播给所有订阅的 WebSocket */
  onFrame: (runId: string, frame: ServerFrame) => void;
  /** 需要提醒用户时触发推送(内容只放不敏感摘要,详情由 App 经组网拉取) */
  onNotify?: (runId: string, kind: "approval" | "done" | "error", text: string) => void;
  /** 这一轮流已结束(子进程退出)。registry 据此摘掉 byCcId 映射,免得死会话被当成"另一端活跃" */
  onClosed?: (runId: string, ccSessionId: string | null) => void;
}

export class CcSession {
  readonly runId: string;
  readonly cwd: string;
  ccSessionId: string | null = null;

  private mode: PermissionMode;
  private input = new AsyncQueue<SDKUserMessage>();
  private q: Query | null = null;
  /**
   * 用来**真的结束**这个子进程。
   *
   * ⚠️ 光 `input.close()` 是不够的:那只把 stdin 关掉,CLI 得先把当前这一轮跑完才会
   * 读到 EOF。而我们要处理的恰恰是"这一轮永远不会结束"(上游 API 卡死)——
   * 那时它会一直挂着。SDK 内部两条路的差别也在这儿:它的 `killAll()` 在 Windows 上
   * 只做 `stdin.end()`,而 **abort** 那条路是"5 秒还没退出就 SIGKILL"。
   * 所以必须把 abortController 交给 SDK,闭环才有保证活口。
   */
  private abort = new AbortController();
  private broker: ApprovalBroker;
  private busy = false;
  private closed = false;
  private lastError: string | null = null;
  private hooks: CcSessionHooks;
  private lastActivityAt = Date.now();
  /**
   * 最近发过的帧 —— 手机重新接入时按它**回放**,让"切屏期间那段输出"重新流一遍。
   *
   * 为什么要它:帧原本**不落任何地方**,切屏期间后端吐出来的 `assistant_delta` 就永远
   * 没了。回来时 App 只能靠"拉一页历史合并"补内容 —— 那是**一次跳变**:中间那段输出
   * 没有"经过"手机,看起来像卡了一下突然刷新。使用者的原话:「直接更新中间的内容,
   * 画面不连续,而且会让用户感觉卡顿」。
   *
   * 保留到**下一次发消息**为止(不是在 result 时清):这样"切屏期间它答完了"也能回放
   * —— 那正是最常见的情况。上限两道(帧数 + 字节数),长回答的 delta 可能有几千帧。
   */
  private log: { at: number; seq: number; bytes: number; frame: ServerFrame }[] = [];
  /**
   * 帧的**单调递增编号** —— 客户端报"我收到哪了"时用它(流的 `?since=`)。
   *
   * ⚠️ 清空日志时**不重置**:客户端手里那个编号跨越了清空点,重置就会和新帧撞上,
   * 于是"能续上"被判成真,而其实中间缺了一整段。
   */
  private nextSeq = 0;
  /**
   * **已经没了**的那些帧的最高编号(被逐条挤掉的,或者整段清掉的)。
   *
   * "还能不能接着补"就比它:客户端报的 `since` 低于它 = 中间缺了一段,
   * **必须重拉历史**,不能假装续上了。
   */
  private droppedBelowSeq = 0;
  /**
   * 最近一次 result 帧报的 token 数 —— 接入时随状态帧一起推,免得重连后停在旧值
   */
  private lastTokens: number | undefined;
  /**
   * **还没送到任何人手上**的那些帧从哪一刻算起(水位)。
   *
   * 两个动作维护它:
   *   - `markNobodyWatching()`(订阅者清零)把水位设成"现在" —— 从那之后发的帧
   *     谁也没看见过
   *   - `takeFramesToReplay()` 取走并**把水位推到刚送出去那一批的末尾** ——
   *     同一段帧不会再被回放第二遍
   *
   * ⚠️ 第二条是后补的,不补会出大问题。原来只有"设水位"、没有"推水位",于是
   * 只要"订阅者清零"这个动作没有干净地发生过(切后台时连接是**悄悄烂掉**的:
   * 手机侧网络没了、服务端这边既没收到 FIN 也没人往里写,`close` 可以几十分钟
   * 都不触发 → 计数一直是 1),水位就**冻在很久以前**,而每一次重连都按它把同一段
   * 老内容整段重发一遍 —— 使用者看到的就是「agent 的话重复两遍甚至多遍,退出重进
   * 也解决不了」。现在取走即推水位,重复只有一次上限(而客户端那边还会按指纹认亲,
   * 见 protocol.ts 的 `replay` 帧)。
   *
   * 水位是**开区间**:取走时推到最后那一帧的时间 +1ms,免得下一轮又把同一帧算进来。
   */
  private replayFrom: number | null = null;
  /**
   * CLI 报的"只在本机终端里有意义"的斜杠命令(见 SDK 的 init 帧)。
   *
   * 手机上打这些命令不会得到任何结果 —— 它们是交互式的(选会话、改状态栏),
   * 在 headless 的流里要么卡住要么报错。App 拿这份名单拦下来,给一句像样的说明。
   * 由 init 帧填充;重连补发时靠 `initExtras()` 带上。
   */
  private terminalSlash: string[] = [];

  constructor(
    cwd: string,
    mode: PermissionMode,
    hooks: CcSessionHooks,
    ccSessionId: string | null = null,
  ) {
    this.runId = crypto.randomUUID();
    this.cwd = cwd;
    this.mode = mode;
    this.hooks = hooks;
    this.ccSessionId = ccSessionId;
    this.broker = new ApprovalBroker(
      (frame) => this.emit(frame),
      (count) => {
        if (count > 0) this.hooks.onNotify?.(this.runId, "approval", "有操作等待你在手机上批准");
      },
    );
  }

  get permissionMode(): PermissionMode {
    return this.mode;
  }

  async start(): Promise<void> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const options = {
      cwd: this.cwd,
      permissionMode: sdkPermissionMode(this.mode),
      includePartialMessages: true,
      // 继承本机环境;cc-switch 的代理会替换真正的上游凭据,这里只需要占位值
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "PROXY_MANAGED" },
      // 见字段 abort 的说明:这是唯一能真正结束一个卡死子进程的开关
      abortController: this.abort,
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        opts: { suggestions?: PermissionUpdate[] },
      ): Promise<PermissionResult> => {
        // 全自动档:一律放行,不推审批。唯一的例外是 AskUserQuestion —— 它借的是同一条
        // 通道,但性质是"模型需要你回答"而不是"申请权限";放行它等于什么都没答
        // (工具会回一句 "The user did not answer the questions.")。所以问答照常推。
        if (this.mode === "bypass" && !parseQuestions(input)) {
          return { behavior: "allow", updatedInput: input };
        }
        const outcome = await this.broker.request(toolName, input, describeDiff(toolName, input));
        if (outcome.decision === "deny") {
          return { behavior: "deny", message: outcome.reason ?? "用户在手机上拒绝了该操作" };
        }
        // AskUserQuestion 的答案由手机回传,必须并进 updatedInput 才会被工具采纳;
        // 只回 allow 而原样带 input 的话,工具结果会是 "The user did not answer the questions."
        const updatedInput = outcome.answers ? { ...input, answers: outcome.answers } : input;
        if (outcome.decision === "always") {
          return {
            behavior: "allow",
            updatedInput,
            updatedPermissions:
              opts.suggestions ??
              ([
                {
                  type: "addRules",
                  rules: [{ toolName }],
                  behavior: "allow",
                  destination: "session",
                },
              ] as PermissionUpdate[]),
          };
        }
        return { behavior: "allow", updatedInput };
      },
      ...(this.ccSessionId ? { resume: this.ccSessionId } : {}),
    };

    this.q = query({ prompt: this.input, options });
    void this.pump();
  }

  /** 喂入一条用户消息;SDK 会把这一轮的所有帧推回来 */
  send(text: string, images: ImageAttachment[] = []): void {
    if (this.closed) throw new Error("会话已关闭");
    /**
     * ⚠️ **流已经结束的会话必须拒绝接收,不能默默吞掉。**
     *
     * 这是使用者反馈的「发消息会死」的根因(2026-09-20)。子进程退出后 `pump()` 会把
     * `q` 置空,但那个会话**仍然留在 registry 的 sessions 表里** —— 而空闲回收器
     * (registry.ts)在"有人看着"时是不动的(`subscriberCount > 0` 直接 continue),
     * 手机一直连着就一直不回收。于是:
     *   后端收到了消息 → 这里把 `busy` 置 true、push 进一个**没有任何消费者的队列** →
     *   CLI 早就没了,jsonl 里一个字都不会写。
     * 手机上看到的就是「界面在、一直正在思考、退出去重进来发现我的输入没写进 jsonl」。
     *
     * 抛出去之后由 routes/stream.ts 回一帧 `recoverable: false` —— App 的
     * `useSessionStream` 正是拿这一帧触发自愈(resume 一条新的),并把草稿还回去。
     */
    if (this.q === null) throw new Error("这条会话的流已经结束了");
    // 新一轮开始了:上一轮的帧不再属于"你错过的内容",清掉免得回放出上一次的回答
    this.log = [];
    // ⚠️ 清掉之后要**记住清到哪了** —— 否则"客户端报的 since 比现存最老的帧还小"会被
    // 算成"能续上",而它其实缺了一整段(见 droppedBelowSeq)
    if (this.nextSeq > this.droppedBelowSeq) this.droppedBelowSeq = this.nextSeq;
    // 人刚刚在场(这条消息就是他发的),没有"错过的内容"要补
    this.replayFrom = null;
    this.busy = true;
    this.lastActivityAt = Date.now();

    // 图片排在文字前面 —— 官方的图片理解示例就是这个顺序,让模型先看到图再看问题。
    const content: unknown[] = images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    }));
    // 只发图不打字是合法的("这张图怎么了"),此时不要塞一个空的 text 块,上游会拒。
    if (text.trim()) content.push({ type: "text", text });

    this.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  async interrupt(): Promise<void> {
    this.broker.denyAll("用户中断了这一轮");
    try {
      await this.q?.interrupt();
    } catch (err) {
      this.emit({ t: "error", message: `中断失败: ${String(err)}`, recoverable: true });
    }
  }

  async setMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    try {
      await this.q?.setPermissionMode(sdkPermissionMode(mode));
      this.emit({ t: "mode_changed", mode });
    } catch (err) {
      this.emit({ t: "error", message: `切换权限模式失败: ${String(err)}`, recoverable: true });
    }
  }

  respondPermission(
    reqId: string,
    decision: PermissionDecision,
    reason?: string,
    answers?: Record<string, string>,
  ): RespondResult {
    return this.broker.respond(reqId, decision, reason, answers);
  }

  /** 未决审批的帧,手机一连上就按这个补发(见 routes/stream.ts) */
  pendingApprovalFrames(): PendingApproval[] {
    return this.broker.listPending();
  }

  /**
   * init 帧里那两个"环境事实"字段(shell 与终端专用命令)。
   *
   * ⚠️ 单独抽出来是因为**两个地方要发这一帧**:runner 自己发首次的那一份,
   * `routes/stream.ts` 在手机重连到已初始化的会话时也要补一份。两处各写一遍
   * 迟早会漏 —— 漏了的后果是"切一次屏,拦截名单就丢了"。
   */
  initExtras(): { shell: string; terminalSlashCommands?: string[] } {
    return {
      shell: SHELL_LABEL,
      ...(this.terminalSlash.length > 0 ? { terminalSlashCommands: this.terminalSlash } : {}),
    };
  }

  get pendingApprovals(): number {
    return this.broker.size;
  }

  /**
   * 会话还活着吗(claude 子进程的流未结束)。
   * `q` 在 start() 里赋值、在 pump() 的 finally 里置空,所以它能当存活标志。
   * 死会话不该再被当作"另一端活跃"。
   */
  get isAlive(): boolean {
    return !this.closed && this.q !== null;
  }

  /**
   * 关掉这个会话:拒掉未决审批、关输入队列、**并且真的把子进程结束掉**。
   *
   * ⚠️ 最后那一步是后补的。原来只有 `input.close()`,而它只是关 stdin —— 对"这一轮
   * 永远不会结束"的卡死会话完全无效,进程会一直挂到下次重启后端(实测就是:任务管理
   * 器里留着 claude.exe,而且没人再管它)。`abort()` 走的才是 SDK 里"5 秒还没退出就
   * SIGKILL"那条路,见字段 `abort` 的说明。
   */
  close(): void {
    this.closed = true;
    this.broker.denyAll("会话已关闭");
    this.input.close();
    this.abort.abort();
  }

  /** 回收一个"卡住"的会话之前告诉使用者一声 —— 不然他会以为自己那句话凭空没了 */
  notifyStuck(): void {
    this.hooks.onNotify?.(
      this.runId,
      "error",
      "这个会话长时间没有任何输出,已在电脑上回收;重新打开即可继续",
    );
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get idleMs(): number {
    return Date.now() - this.lastActivityAt;
  }

  get error(): string | null {
    return this.lastError;
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q as Query) {
        this.handle(msg);
      }
    } catch (err) {
      // 我们自己 abort 关掉的,不算"异常终止" —— 那是正常回收,推一条错误通知只会
      // 让人以为出了故障(而且回收恰恰发生在没人在场的时候)
      if (!this.closed) {
        this.lastError = String(err);
        this.emit({ t: "error", message: `会话异常终止: ${String(err)}`, recoverable: false });
        this.hooks.onNotify?.(this.runId, "error", "会话异常终止,请打开 App 查看");
      }
    } finally {
      this.busy = false;
      this.q = null;
      this.emit({ t: "result", subtype: "closed" });
      // 流已结束,告知 registry 摘掉映射,否则这个死会话会在 byCcId 里留 30~35 分钟,
      // 期间用户点「继续对话」会被误判成"另一端活跃"
      this.hooks.onClosed?.(this.runId, this.ccSessionId);
    }
  }

  private handle(msg: SDKMessage): void {
    /**
     * ⚠️ **子代理(Task)内部的往返不能进主会话。**
     *
     * SDK 把子代理的消息和主会话的**混在同一条流里**推过来,靠 `parent_tool_use_id`
     * 区分(非空 = 它属于某次 Task 调用内部)。不过滤的后果,使用者的原话是
     * 「子代理回报的上下文会被加载到主会话里面和主代理的一起渲染,导致我看到的出现混乱」——
     * 子代理读的每个文件、跑的每条命令,都会当成主代理干的事铺进对话里。
     *
     * ⚠️ 而**历史侧是过滤掉的**(`parser.ts` 的 `isSidechain`)→ 于是同一个会话
     * 出现了最误导的那种不一致:**刷新一下那些噪声就没了**。两边必须用同一个口径,
     * 这里补上另一半。
     *
     * 只砍这三种带 `parent_tool_use_id` 的帧;`result` / `system` 是会话级的,
     * 动它们会把"这一轮跑完了"之类的信号一起砍掉。子代理最终交回来的那份**报告**
     * 走的是 Task 自己的 tool_result,Top-level、parent 为空 —— 所以它照样看得到。
     */
    if (msg.type === "assistant" || msg.type === "user" || msg.type === "stream_event") {
      if ((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id) return;
    }

    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          this.ccSessionId = msg.session_id;
          // CLI 自己报的"只在本机终端里有意义"的命令(exit / statusline 之类)。
          // 存下来:重连时补发的 init 帧也要带上,否则切一次屏 App 就把拦截名单丢了。
          this.terminalSlash = msg.terminal_slash_commands ?? [];
          this.emit({
            t: "system",
            subtype: "init",
            sessionId: msg.session_id,
            model: msg.model,
            cwd: msg.cwd,
            ...this.initExtras(),
          });
        }
        break;
      }
      case "stream_event": {
        const event = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          this.emit({ t: "assistant_delta", text: event.delta.text });
        }
        break;
      }
      case "assistant": {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        const blocks = blocksFromContent("assistant", content);
        const visible = blocks.filter((b) => b.type !== "thinking");
        if (visible.length > 0) this.emit({ t: "assistant_message", blocks: visible });
        break;
      }
      case "user": {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        for (const block of blocksFromContent("user", content)) {
          if (block.type === "tool_result") {
            this.emit({
              t: "tool_result",
              id: block.toolUseId ?? "",
              content: block.text,
              isError: block.isError,
            });
          }
        }
        break;
      }
      case "result": {
        this.busy = false;
        const r = msg as {
          subtype?: string;
          total_cost_usd?: number;
          duration_ms?: number;
          modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>;
        };
        // token 用量取 modelUsage 而不是 usage:后者只算主 agent 循环、且按轮计,
        // 不含 Task 子代理与辅助调用。SDK 自己的文档也推荐用 modelUsage 做计量。
        // 只累计 input + output —— 缓存读写量极大(每轮重读上下文),混进来会让
        // "消耗"这个数字失去意义。
        let tokens: number | undefined;
        if (r.modelUsage) {
          let n = 0;
          for (const m of Object.values(r.modelUsage)) {
            n += (m.inputTokens ?? 0) + (m.outputTokens ?? 0);
          }
          tokens = n;
        }
        this.lastTokens = tokens;
        this.emit({
          t: "result",
          subtype: r.subtype ?? "success",
          costUsd: r.total_cost_usd,
          durationMs: r.duration_ms,
          tokens,
        });
        this.hooks.onNotify?.(this.runId, "done", "这一轮已完成,可以查看结果了");
        break;
      }
      default:
        break;
    }
  }

  private emit(frame: ServerFrame): void {
    this.lastActivityAt = Date.now();
    const bytes = JSON.stringify(frame).length;
    this.log.push({ at: Date.now(), seq: ++this.nextSeq, bytes, frame });
    // 从头上丢,丢到两条上限都满足 —— 保留最近的,因为回放要的是"刚过去那段"
    let total = this.log.reduce((n, f) => n + f.bytes, 0);
    while (this.log.length > FRAME_LOG_MAX || total > FRAME_LOG_BYTES) {
      const dropped = this.log.shift();
      if (!dropped) break;
      total -= dropped.bytes;
      if (dropped.seq > this.droppedBelowSeq) this.droppedBelowSeq = dropped.seq;
    }
    this.hooks.onFrame(this.runId, frame);
  }

  /**
   * 接入时的**状态快照**(也是每 15 秒一次的心跳内容)。
   *
   * `busy` 只能从帧里推(`assistant_delta` 置忙、`result` 置闲),而帧丢了就永远不知道 ——
   * 切屏期间那一轮结束时 `result` 帧没人接,回来就一直显示"正在思考"。所以每次接入
   * 推一份真值,和 `mode_changed` 一个道理:状态类的东西不能只靠帧。
   *
   * `idleMs` 回答的是另一个问题:"它还在跑、还是卡住了"。agent 跑一个长时间不出声的
   * 东西(定时任务、好几分钟不回话的工具调用)时 `busy` 一直是 true,光凭它没法判断
   * 该不该打断 —— 这个值让界面能说"已静默 3 分钟"。
   */
  stateSnapshot(): { busy: boolean; tokens?: number; idleMs: number; seq: number } {
    return {
      busy: this.busy,
      ...(this.lastTokens !== undefined ? { tokens: this.lastTokens } : {}),
      idleMs: this.idleMs,
      // 客户端拿它当"我收到哪了",下次重连报回来(见 takeFramesToReplay)
      seq: this.nextSeq,
    };
  }

  /** 手机全部断开时由 registry 调 —— 之后发出的帧都要留给下次接入时回放 */
  markNobodyWatching(): void {
    this.replayFrom = Date.now();
  }

  /**
   * 发一帧**不进帧日志**的帧。
   *
   * 给"不属于这个会话、但要借它的流发给手机"的东西用 —— 目前只有提权请求那张红卡。
   * 为什么不走 `emit`:那种帧进去之后会被**回放**(重连时再发一遍),而一张"请你批准
   * 提权"的卡是**一次性**的:批完/拒完之后再冒出来只会让人以为又要批一次。
   * 需要补发的场景由接入时按 `listPending()` 现取(见 routes/stream.ts)。
   */
  pushTransient(frame: ServerFrame): void {
    this.hooks.onFrame(this.runId, frame);
  }

  /**
   * 取走"你不在时"发出的那些帧。
   *
   * 两条路:
   *  · **客户端报了它到哪了**(`since`)= **精确补** —— 这也是"重连不必重拉历史"的依据:
   *    能补齐就不必再花十几秒去拉那 44KB(实测这条链路只有 ~3 KB/s)。
   *  · 没报(手上有新历史、或老版本 App)= 走水位那条老路,行为与以前一模一样。
   *
   * `complete` 只对第一条路有意义:false = **中间有一段已经没了**,客户端必须重拉历史,
   * 不能装作续上了(那正是坑 40 那一类错误的形状)。
   */
  takeFramesToReplay(since?: number | null): { frames: ServerFrame[]; complete: boolean } {
    if (since !== undefined && since !== null) {
      return {
        frames: this.log.filter((f) => f.seq > since).map((f) => f.frame),
        complete: since >= this.droppedBelowSeq,
      };
    }
    // 老路子:没接入过(水位是 null)时给空 —— 那种情况 App 手上刚拉到一份历史铺底,
    // 不需要回放,硬塞一遍只会让同一段内容出现两次
    const from = this.replayFrom;
    if (from === null) return { frames: [], complete: true };
    const due = this.log.filter((f) => f.at >= from);
    // 空的那一批不动水位 —— 之后接入的人还能拿到这之后的帧
    if (due.length > 0) this.replayFrom = due[due.length - 1]!.at + 1;
    return { frames: due.map((f) => f.frame), complete: true };
  }

  /** 截到此刻的帧编号 —— 随接入时的 state 帧给客户端,它下次重连就报这个数 */
  currentSeq(): number {
    return this.nextSeq;
  }
}

/** 审批卡片上给用户看的摘要。完整 diff 由前端按需拉取 */
function describeDiff(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "Bash" && typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return String(input.file_path);
  return undefined;
}

export type { ChatBlock };
