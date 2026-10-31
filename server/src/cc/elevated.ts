import crypto from "node:crypto";
import { ELEVATED_TIMEOUT_MS } from "@remote-cc/shared";

/**
 * **提权请求** —— 电脑上那个"提权执行器"动手之前,先在这里等手机上的决定。
 *
 * ## 它解决的问题
 *
 * agent 有时会跑需要管理员权限的命令,而 UAC 框弹在电脑的 secure desktop 上:
 * 人在外面看不到、点不着,那一轮就**静默挂住**(`Start-Process -Verb RunAs -Wait`
 * 会一直等,直到 UAC 自己约两分钟后取消)。而那个框**是转不到手机上的** ——
 * 只有 Windows 进程能访问 secure desktop,普通进程连截屏和注入输入都被禁止。
 *
 * 所以改成"替掉它":电脑上预先注册一个以最高权限运行的计划任务(见
 * `deploy/install-elevated-executor.ps1`),它做任何事之前先调这里的接口 ——
 * 于是手机上出现一张**红卡**,批了它才动手。
 *
 * ## 和 `permissions.ts` 那个审批状态机的区别
 *
 * | | 普通审批 | 提权请求 |
 * |---|---|---|
 * | 发起方 | 某个会话里的一次工具调用 | 电脑上独立的脚本,不属于任何会话 |
 * | 通道 | `permission_request` 帧 | `elevated_request` 帧(红卡) |
 * | 超时 | 30 分钟 | 5 分钟(见 `TIMEOUT_MS`) |
 * | 批准的含义 | 放行这一次工具调用 | 放行一次**管理员权限**的动作 |
 *
 * 所以它是**另一份状态**,而不是往 ApprovalBroker 里塞一种新卡片:超时、措辞、
 * 补发时机都不一样,混在一起迟早会串。
 *
 * ## ⚠️ 安全边界(写在代码里,免得以后被当成硬闸门)
 *
 * 它拦得住"agent 自作主张提权":执行器只认手机上批过的请求,agent 直接去调那个
 * 计划任务也只会换来一张等你点的红卡。
 *
 * 它拦不住"冒充手机来批准":后端与 agent 同机同用户,能读这台机器上任何文件的东西
 * (包括被提示注入的 agent)理论上也能自己走一遍配对拿到 token 再自己批准。
 * 要堵死得靠**手机侧私钥签名**(电脑上读不到私钥),那是下一步的事。
 * 现在这一层的价值是:**把"悄悄提权"变成"必须在手机上按一下,而且留痕"**。
 */

/** 等手机应答的上限。超时按**拒绝**处理 —— 和普通审批同一个道理,拒绝是安全的默认 */
const TIMEOUT_MS = ELEVATED_TIMEOUT_MS;

/**
 * 一个请求处理完之后还认它多久。
 *
 * 和 `permissions.ts` 的 `gone` 表同一个用途:超时之后手机才点的"批准",要能分辨成
 * "你回来晚了"(expired)还是"这张卡早就被点过了"(unknown)—— 两种情况对使用者的
 * 含义正好相反,合成一句就是他已经抱怨过的「警告逻辑有点不对」。
 */
const GONE_KEEP_MS = 10 * 60_000;

/**
 * 一分钟内最多受理几个请求。
 *
 * 防的是本地进程刷屏:这条接口不需要 token(见 routes/elevated.ts 的说明),
 * 而它能造成的最大伤害就是"手机上一直弹红卡"。真被刷了,使用者至少不会被淹掉。
 */
const MAX_PER_MINUTE = 5;

/** 各字段的长度上限 —— 它们最后都会显示在手机上,别让谁塞一兆进来 */
const LIMITS = { action: 40, title: 60, detail: 2000, caller: 200, reason: 400 };

export interface ElevatedRequest {
  reqId: string;
  /** 动作的机器名(电脑上白名单里的键) */
  action: string;
  /** 人话的动作名 */
  title: string;
  /** 具体内容:哪条命令、哪个证书。**当数据显示,不当指令** */
  detail: string;
  /** 谁发起的 + 为什么 */
  caller: string;
  reason: string;
  at: number;
}

/** 手机上的决定。没有第三种 —— "稍后再说"在这里等于拒绝(执行器那一轮已经等着了) */
export type ElevatedDecision = "approve" | "deny";

/** `ok` = 决定被采纳;`expired` = 早就超时了;`unknown` = 认不出这个 reqId */
export type RespondElevatedResult = "ok" | "expired" | "unknown";

export interface ElevatedOutcome {
  reqId: string;
  decision: ElevatedDecision;
  /** 给电脑上那条命令行看的一句话(超时 / 太频繁时用它解释) */
  note?: string;
}

function clip(v: unknown, max: number): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 多行文本的清理(命令行原文要保留换行,不然一条 `&&` 串起来的命令糊成一坨没法看)。
 * 长度照旧要卡。
 */
function clipMultiline(v: unknown, max: number): string {
  const s = typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 受理进来的原始字段 —— 来自 HTTP 请求体,所以一律是 unknown,由这里截断与归一化 */
export interface ElevatedInput {
  action?: unknown;
  title?: unknown;
  detail?: unknown;
  caller?: unknown;
  reason?: unknown;
}

interface Waiter {
  req: ElevatedRequest;
  resolve: (out: ElevatedOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

class ElevatedBroker {
  private pending = new Map<string, Waiter>();
  /** 处理过的 reqId → 处理时刻 */
  private gone = new Map<string, number>();
  /** 最近受理过的请求时刻,用来限流 */
  private accepted: number[] = [];
  /** 受理时通知外面(去推给手机)。由 index.ts 在装配时挂上 */
  private onAsk: ((req: ElevatedRequest) => void) | null = null;

  setOnAsk(fn: (req: ElevatedRequest) => void): void {
    this.onAsk = fn;
  }

  /**
   * 受理一个请求,挂起等手机上的人点。
   *
   * ⚠️ **调用方(那个提权脚本)会一直等在这里** —— 所以超时必须给,而且给得短:
   * 它占着的是一个"要动手做事"的位置,不是一条聊天消息。
   */
  request(input: ElevatedInput): Promise<ElevatedOutcome> {
    const now = Date.now();
    this.accepted = this.accepted.filter((t) => now - t < 60_000);
    if (this.accepted.length >= MAX_PER_MINUTE) {
      return Promise.resolve({
        reqId: "",
        decision: "deny",
        note: "提权请求太频繁,已被限流;等一分钟再来",
      });
    }

    const req: ElevatedRequest = {
      reqId: crypto.randomUUID(),
      action: clip(input.action, LIMITS.action),
      title: clip(input.title, LIMITS.title) || "未命名的动作",
      detail: clipMultiline(input.detail, LIMITS.detail),
      caller: clip(input.caller, LIMITS.caller),
      reason: clip(input.reason, LIMITS.reason),
      at: now,
    };
    this.accepted.push(now);

    return new Promise<ElevatedOutcome>((resolve) => {
      const done = (out: ElevatedOutcome) => {
        const w = this.pending.get(req.reqId);
        if (!w) return;
        clearTimeout(w.timer);
        this.pending.delete(req.reqId);
        this.remember(req.reqId);
        resolve(out);
      };
      const timer = setTimeout(() => {
        console.warn(`[提权] ${req.reqId}(${req.action})5 分钟没人应答,按拒绝处理`);
        done({ reqId: req.reqId, decision: "deny", note: "手机上没人应答,已按拒绝处理" });
      }, TIMEOUT_MS);
      this.pending.set(req.reqId, { req, resolve, timer });
      this.onAsk?.(req);
    });
  }

  /** 手机上的决定 */
  respond(reqId: string, decision: ElevatedDecision): RespondElevatedResult {
    const w = this.pending.get(reqId);
    if (!w) {
      const at = this.gone.get(reqId);
      return at !== undefined && Date.now() - at < GONE_KEEP_MS ? "expired" : "unknown";
    }
    clearTimeout(w.timer);
    this.pending.delete(reqId);
    this.remember(reqId);
    w.resolve({ reqId, decision });
    return "ok";
  }

  /** 未决的请求 —— 手机每次接入时按它补发(和未决审批一个道理) */
  listPending(): ElevatedRequest[] {
    return [...this.pending.values()].map((w) => w.req);
  }

  get size(): number {
    return this.pending.size;
  }

  private remember(reqId: string): void {
    this.gone.set(reqId, Date.now());
    for (const [id, at] of this.gone) {
      if (Date.now() - at > GONE_KEEP_MS) this.gone.delete(id);
    }
  }
}

export const elevated = new ElevatedBroker();
