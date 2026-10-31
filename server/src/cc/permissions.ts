import crypto from "node:crypto";
import {
  PERMISSION_TIMEOUT_MINUTES,
  PERMISSION_TIMEOUT_MS,
  type PermissionDecision,
  type ServerFrame,
} from "@remote-cc/shared";

export interface ApprovalOutcome {
  decision: PermissionDecision;
  reason?: string;
  /** AskUserQuestion 专用:{ 问题文本: 答案 };由 runner 合并进 updatedInput 回填给工具 */
  answers?: Record<string, string>;
}

/**
 * 回执认不出来的两种原因。
 *
 * ⚠️ **必须分开**。原来两者共用一句「该审批已超时或已被处理」,而这两件事对使用者
 * 的含义完全相反:超时 = "你回来晚了,它已经被自动拒了"(要重新发起),已处理 =
 * "你(或另一台设备)点过了"。合成一句只会让人以为是自己点重了。
 */
export type RespondResult = "ok" | "expired" | "unknown";

/** 最近超时的 reqId 留多久 —— 只为了把回执说清楚,不参与任何判定 */
const EXPIRED_KEEP_MS = 10 * 60_000;
const EXPIRED_KEEP_MAX = 200;

/** 手机重连时用来补发审批卡的那一帧 —— 就是 `permission_request` 本身 */
export type PendingApproval = Extract<ServerFrame, { t: "permission_request" }>;

interface Pending {
  reqId: string;
  tool: string;
  /**
   * ⚠️ 这两个字段不只是给**首次**推送用的。
   *
   * 手机切后台时断线期间发出的 `permission_request` 没有任何人接,而且帧本身不留存 ——
   * 只留 tool 名字的话,重连时补出来的卡片是空的(没有"要改哪个文件""改了什么")。
   */
  input: unknown;
  diff?: string;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * 审批状态机。手机是唯一应答方,因此:
 * - 超时(见 PERMISSION_TIMEOUT_MS)按 deny 处理 —— 这条是真正的兜底
 * - 手机重连时按 `listPending()` 把未决审批**补发**回去(见 stream.ts)
 *
 * 历史:曾经还有"连接断开 20 秒就 denyAll"。那条已经去掉了 ——
 * 它比超时**早得多**地拒掉了本来还能被批准的请求(切屏回来审批全没了就是这么来的),
 * 而"手机掉线后 PC 无人值守地执行"这个担心,超时本身就已经挡住了。
 */
export class ApprovalBroker {
  private pending = new Map<string, Pending>();
  /** 最近超时/被处理掉的 reqId → 时刻。只为把"认不出的回执"解释清楚,见 RespondResult */
  private gone = new Map<string, number>();
  private emit: (frame: ServerFrame) => void;
  private onPendingChange?: (count: number) => void;

  constructor(
    emit: (frame: ServerFrame) => void,
    onPendingChange?: (count: number) => void,
  ) {
    this.emit = emit;
    this.onPendingChange = onPendingChange;
  }

  get size(): number {
    return this.pending.size;
  }

  request(tool: string, input: unknown, diff?: string): Promise<ApprovalOutcome> {
    const reqId = crypto.randomUUID();
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this.remember(reqId);
        this.notify();
        // 留痕,而且要能和服务端"收到认不出的回执"那行**对着看**:
        // 只有这一行 = 回执压根没到(手机侧的事);两行都有 = 到了但认不出(超时或串了会话)。
        // 没有这行的话,"我点了提交但没反应"事后完全查不出来。
        console.warn(
          `[审批] ${tool} 超时被拒(${PERMISSION_TIMEOUT_MINUTES} 分钟内没有任何回执)`,
        );
        resolve({
          decision: "deny",
          reason: `审批超时:手机未在 ${PERMISSION_TIMEOUT_MINUTES} 分钟内响应,已自动拒绝`,
        });
      }, PERMISSION_TIMEOUT_MS);
      timer.unref?.();

      this.pending.set(reqId, { reqId, tool, input, diff, resolve, timer });
      this.emit({ t: "permission_request", reqId, tool, input, diff });
      this.notify();
    });
  }

  /**
   * 未决审批的快照。手机一连上就按这个补发一遍。
   *
   * 不补发的话:切屏期间产生的审批帧发给了"当时没有的订阅者",等于石沉大海 ——
   * 回来看到空白,卡片再也不出现,只能等超时被拒。
   */
  listPending(): PendingApproval[] {
    return [...this.pending.values()].map((p) => ({
      t: "permission_request",
      reqId: p.reqId,
      tool: p.tool,
      input: p.input,
      ...(p.diff ? { diff: p.diff } : {}),
    }));
  }

  /**
   * 手机答了一个审批。
   *
   * ⚠️ 返回值是**三态**不是布尔:见 RespondResult。调用方要把 `expired` 和 `unknown`
   * 分开说 —— 合成一句"已超时或已被处理"正是使用者反馈的那条「警告逻辑有点不对」。
   */
  respond(
    reqId: string,
    decision: PermissionDecision,
    reason?: string,
    answers?: Record<string, string>,
  ): RespondResult {
    const pending = this.pending.get(reqId);
    if (!pending) {
      const at = this.gone.get(reqId);
      return at !== undefined && Date.now() - at < EXPIRED_KEEP_MS ? "expired" : "unknown";
    }
    clearTimeout(pending.timer);
    this.pending.delete(reqId);
    this.remember(reqId);
    pending.resolve({ decision, reason, answers });
    this.notify();
    return "ok";
  }

  denyAll(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      this.remember(p.reqId);
      p.resolve({ decision: "deny", reason });
    }
    this.pending.clear();
    this.notify();
  }

  /** 记一笔"这个 reqId 已经不在未决表里了",顺带把过期的条目清掉 */
  private remember(reqId: string): void {
    const now = Date.now();
    this.gone.set(reqId, now);
    if (this.gone.size <= EXPIRED_KEEP_MAX) return;
    for (const [id, at] of this.gone) {
      if (now - at > EXPIRED_KEEP_MS) this.gone.delete(id);
    }
    // 还超量就按插入顺序丢最旧的(Map 保序,插入序即时间序)
    while (this.gone.size > EXPIRED_KEEP_MAX) {
      const oldest = this.gone.keys().next().value;
      if (oldest === undefined) break;
      this.gone.delete(oldest);
    }
  }

  private notify(): void {
    this.onPendingChange?.(this.pending.size);
  }
}
