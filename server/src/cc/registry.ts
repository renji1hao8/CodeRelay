import type { PermissionMode, ServerFrame } from "@remote-cc/shared";
import { CcSession } from "./runner.ts";

export type FrameListener = (runId: string, frame: ServerFrame) => void;
export type NotifyListener = (runId: string, kind: "approval" | "done" | "error", text: string) => void;

const sessions = new Map<string, CcSession>();

const byCcId = new Map<string, CcSession>();
const frameListeners = new Set<FrameListener>();
const notifyListeners = new Set<NotifyListener>();
const subscriberCounts = new Map<string, number>();

/** 由 stream 路由维护:手机连上/断开时更新,供空闲回收判断 */
export function addSubscriber(runId: string): void {
  subscriberCounts.set(runId, (subscriberCounts.get(runId) ?? 0) + 1);
}

export function removeSubscriber(runId: string): void {
  const next = (subscriberCounts.get(runId) ?? 0) - 1;
  if (next <= 0) {
    subscriberCounts.delete(runId);
    // 从这一刻起没人看着 —— 之后发出的帧都要留给下次接入时回放(见 CcSession 的帧日志)
    sessions.get(runId)?.markNobodyWatching();
  } else {
    subscriberCounts.set(runId, next);
  }
}

export function subscriberCount(runId: string): number {
  return subscriberCounts.get(runId) ?? 0;
}

export function onFrame(listener: FrameListener): () => void {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

export function onNotify(listener: NotifyListener): () => void {
  notifyListeners.add(listener);
  return () => notifyListeners.delete(listener);
}

function hooks() {
  return {
    onFrame: (runId: string, frame: ServerFrame) => {
      if (frame.t === "system" && frame.subtype === "init") {
        const session = sessions.get(runId);
        if (session) byCcId.set(frame.sessionId, session);
      }
      for (const listener of frameListeners) listener(runId, frame);
    },
    onNotify: (runId: string, kind: "approval" | "done" | "error", text: string) => {
      for (const listener of notifyListeners) listener(runId, kind, text);
    },
    onClosed: (runId: string, ccSessionId: string | null) => {
      /**
       * ⚠️ **顺手把 sessions 里的死条目摘掉。**
       *
       * 这是「发消息会死」的另一半(另一半在 `CcSession.send` 的 `q === null` 守卫)。
       * 原来这里只清 `byCcId`,`sessions` 那条会一直留到空闲回收器动手 —— 而回收器在
       * "有人看着"时是不动的(`subscriberCount > 0` 直接 continue),手机一直连着,
       * 那条子进程已经没了的会话就**永远在**,后面发来的消息全被吞进空队列。
       *
       * 摘掉之后,重连会走到 stream 路由开头那句"会话不存在或已结束"(recoverable:false),
       * App 据此自愈成一条新会话。
       */
      sessions.delete(runId);
      if (!ccSessionId) return;
      // 只在映射仍指向"这一条"时才删 —— 同一 ccSessionId 可能已被更晚的会话接管,
      // 那种情况下删掉会把新会话的映射也一并抹掉
      if (byCcId.get(ccSessionId)?.runId === runId) byCcId.delete(ccSessionId);
    },
  };
}

export function getSession(runId: string): CcSession | null {
  return sessions.get(runId) ?? null;
}

/**
 * 同一 CC 会话在任一端活跃时,另一端只读,避免并发写坏同一个 jsonl。
 *
 * "活跃"必须同时是"活着的":子进程已退出的会话仍可能留在表里(onClosed 之外
 * 还有进程被强杀等路径),那种条目会让用户在完全没在用的时候被拒之门外。
 */
export function activeSessionForCcId(ccSessionId: string): CcSession | null {
  const session = byCcId.get(ccSessionId);
  if (!session) return null;
  if (!session.isAlive) {
    if (byCcId.get(ccSessionId) === session) byCcId.delete(ccSessionId);
    return null;
  }
  return session;
}

export async function createSession(cwd: string, mode: PermissionMode): Promise<CcSession> {
  const session = new CcSession(cwd, mode, hooks());
  sessions.set(session.runId, session);
  await session.start();
  return session;
}

export async function resumeSession(
  ccSessionId: string,
  cwd: string,
  mode: PermissionMode,
): Promise<CcSession> {
  const existing = byCcId.get(ccSessionId);
  if (existing?.isAlive) return existing;
  // 死条目让位:不起新进程就会一直卡在一个没有子进程的会话上
  if (existing) byCcId.delete(ccSessionId);

  const session = new CcSession(cwd, mode, hooks(), ccSessionId);
  sessions.set(session.runId, session);
  byCcId.set(ccSessionId, session);
  await session.start();
  return session;
}

export function closeSession(runId: string): boolean {
  const session = sessions.get(runId);
  if (!session) return false;
  session.close();
  sessions.delete(runId);
  if (session.ccSessionId && byCcId.get(session.ccSessionId) === session) {
    byCcId.delete(session.ccSessionId);
  }
  return true;
}

export function listLive(): { runId: string; ccSessionId: string | null; cwd: string; busy: boolean }[] {
  return [...sessions.values()].map((s) => ({
    runId: s.runId,
    ccSessionId: s.ccSessionId,
    cwd: s.cwd,
    busy: s.isBusy,
  }));
}

/**
 * 把一帧发给**所有活着的会话流**。
 *
 * 给"不属于任何一个会话"的事件用 —— 目前只有提权请求那张红卡:发起方是电脑上
 * 独立的那个脚本,谁也不知道使用者此刻正开着哪一条会话。每条流都推一份,他在哪一屏
 * 都能看到;谁先点了算谁的(重复的卡由 reqId 认,服务端只认第一次)。
 *
 * ⚠️ 走 `pushTransient`(不进帧日志)—— 理由见 CcSession.pushTransient 的说明。
 */
export function broadcastTransient(frame: ServerFrame): number {
  let sent = 0;
  for (const session of sessions.values()) {
    if (subscriberCount(session.runId) === 0) continue;
    session.pushTransient(frame);
    sent += 1;
  }
  return sent;
}

/** 随便挑一个活着的会话,给"不知道该链到哪"的通知当落点(没有就返回 null) */
export function firstLiveCcId(): string | null {
  for (const session of sessions.values()) {
    if (session.ccSessionId) return session.ccSessionId;
  }
  return null;
}

const IDLE_CLOSE_MS = 30 * 60_000;

/**
 * "忙"的会话多久没有任何帧才算卡死。
 *
 * ⚠️ 为什么忙的会话要**单独一档、而且给得这么宽**:忙 = 有一轮正在跑,而一轮里正常
 * 也会有长时间没有帧的段落 —— 一个跑十分钟的构建、一次大文件下载,中间都是静默。
 * 所以不能拿 IDLE_CLOSE_MS(30 分钟)去套它。
 *
 * 但又**不能**像原来那样直接 `if (session.isBusy) continue`:实测"上游 API 卡死"时
 * 这一轮永远不会结束,`busy` 永远是 true,于是回收器永远不碰它 —— 那个进程就一直挂在
 * 任务管理器里、也没有任何别的东西会来收它(后端手上没有别的杀进程手段)。
 * 这里给一小时,是拿"合法长任务被误杀"换"卡死的进程一定能被收掉";
 * 真被误杀时会推一条通知说明原因,不会静默。
 */
const STUCK_CLOSE_MS = 60 * 60_000;

/**
 * 空闲回收:手机不再连接、也没有正在跑的一轮时,关掉后台的 claude 进程。
 * 否则每次在 App 里点开一个会话都会在电脑上留一个常驻进程。
 */
const reaper = setInterval(() => {
  for (const session of [...sessions.values()]) {
    // 有人看着就不动:卡住时使用者自己能在界面上按中断,不需要我们替他决定
    if (subscriberCount(session.runId) > 0) continue;
    if (session.pendingApprovals > 0) continue;
    if (session.idleMs < (session.isBusy ? STUCK_CLOSE_MS : IDLE_CLOSE_MS)) continue;

    if (session.isBusy) {
      console.warn(
        `[reaper] 回收卡住的会话 ${session.runId}:已 ${Math.round(session.idleMs / 60000)} 分钟没有任何帧,` +
          `但状态仍是"忙"(ccSessionId=${session.ccSessionId ?? "未分配"})`,
      );
      session.notifyStuck();
    }
    closeSession(session.runId);
  }
}, 5 * 60_000);
reaper.unref?.();
