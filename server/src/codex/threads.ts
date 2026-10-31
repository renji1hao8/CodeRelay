import path from "node:path";
import type {
  ChatBlock,
  CodexThreadDetail,
  CodexThreadSummary,
  PermissionDecision,
  ServerFrame,
} from "@remote-cc/shared";
import { broadcastEvent } from "../events.ts";
import { notify } from "../push/push.ts";
import { codexClient } from "./client.ts";
import { assertNoCodexDesktopWriter } from "../desktop/native.ts";
import { messagesOfEntries, blocksOfItem, type CodexItemEntry, type CodexItem } from "./items.ts";

/**
 * Codex 的会话层 —— 列表、历史、以及"活着的那一条"。
 *
 * ## 为什么它跟 `cc/registry.ts` 是两套
 *
 * 那个注册表的 Map 值类型写死 `CcSession`、reaper 依赖它的 `close()` 与审批 broker、
 * 而 `byCcId` 是 CC 的 resume 概念(Codex 是 thread id)。混进去会让 `listLive` /
 * reaper / broadcast 每一处都要分叉。所以这里自己一小套。
 *
 * ## 为什么没有数据库
 *
 * Claude 那边必须把 jsonl 索引进 SQLite,是因为 jsonl 是**流式追加**的、每次读都得
 * 从头扫。而 Codex 的历史**本身就能按需查询**(`thread/read` / `thread/items/list`)——
 * 再索引一份等于多一处会不一致的派生数据。所以只加一个短 TTL 的内存缓存。
 *
 * ## 帧:复用 Claude 那套的**通用**部分
 *
 * `assistant_delta` / `assistant_message` / `state` / `result` / `error` /
 * `permission_request` 这几个与提供商无关,直接复用 —— 于是 App 那边连审批卡都能
 * 沿用现成的(`PermissionDecision` 的 allow/always/deny 恰好对上 Codex 的
 * accept/acceptForSession/decline)。
 */

/** 一帧往哪送。写成回调而不是 WebSocket,是为了这一层不依赖传输 */
export type FrameSink = (frame: ServerFrame) => void;

const LIST_TTL_MS = 20_000;
/**
 * 一页取多少个 item。
 *
 * ⚠️ **从 400 降到 120**(2026-09-27)。实测某条 100 items 的会话详情就有 **231KB**
 * (tool_result 占 45%、tool_use 占 29%) —— 而这条链路的上行只有 ~3 KB/s,
 * 231KB 要七十多秒。所以它是**一页**,不是"一次给全"。
 *
 * ⚠️⚠️ **2026-09-28 修掉一个方向反了的真 bug**:原来这里调 `thread/items/list`
 * **没给 `sortDirection`**,而它**默认是升序** —— 于是"这一页"给的是**最早**的 120 条,
 * 而界面上还写着"更早的内容没有加载"。**正好反了:没加载的是最近的。**
 * 探针实测(`probe-codex-thread.mjs`):不给这一项的那一页与显式 `asc` 的**逐字节相同**。
 *
 * 现在的取法:倒序取一页 → 内部翻回正序给界面 → `nextCursor` 就是"更早"的游标。
 * 于是超出一页的老内容**能一直往上翻**(Claude 那边有,这边原来只能干看着)。
 */
const ITEM_PAGE = 120;
/** 审批超时。照 Claude 那边的 30 分钟 —— 它兜的是"没人应答",不该惩罚"人在认真看" */
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

function isoOf(v: unknown): string | null {
  const n = typeof v === "number" ? v : null;
  if (n === null) return null;
  // Codex 的时间戳有的是秒、有的是毫秒 —— 按数量级认
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------- 列表 / 历史

interface RawThread {
  id?: unknown;
  name?: unknown;
  preview?: unknown;
  cwd?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  recencyAt?: unknown;
}

function toSummary(t: RawThread): CodexThreadSummary | null {
  const id = typeof t.id === "string" ? t.id : null;
  if (!id) return null;
  const name = typeof t.name === "string" && t.name.trim() ? t.name.trim() : null;
  return {
    id,
    name,
    cwd: typeof t.cwd === "string" ? t.cwd : null,
    createdAt: isoOf(t.createdAt),
    updatedAt: isoOf(t.updatedAt ?? t.recencyAt),
    preview: typeof t.preview === "string" ? t.preview.slice(0, 200) : "",
  };
}

/** 列表一页多少条,以及封顶。给多了这条链路也扛不住 */
const LIST_PAGE = 60;
const MAX_LIST_PAGE = 200;

export interface ThreadListQuery {
  limit?: number | string | null;
  /** 上一页给的 `nextCursor`,原样带回来。不给 = 第一页(最新的那一批) */
  cursor?: string | null;
  /** 服务端搜索词。**是 Codex 自己按标题过滤**,不是拿回来我们再筛 */
  q?: string | null;
  /** `true` = 要归档那一份;否则只给未归档的 */
  archived?: boolean;
}

export interface ThreadListPage {
  threads: CodexThreadSummary[];
  /** 下一页的游标。`null` = 到头了 */
  nextCursor: string | null;
}

/**
 * 列表缓存。
 *
 * ⚠️ **只缓存"无搜索词、未归档、第一页"那一种**(与 App 的内存缓存同一个口径)。
 * 别的组合一律直通 —— 把搜索结果缓存成整份列表(或者反过来)是那种"看着能用、
 * 其实串了"的错,而且只在特定操作顺序下才现形。
 */
let listCache: { at: number; value: CodexThreadSummary[]; nextCursor: string | null } | null = null;

export async function listThreads(query: ThreadListQuery = {}): Promise<ThreadListPage> {
  const limit = Math.min(Math.max(Number(query.limit) || LIST_PAGE, 1), MAX_LIST_PAGE);
  const cursor = typeof query.cursor === "string" && query.cursor ? query.cursor : null;
  const q = typeof query.q === "string" && query.q.trim() ? query.q.trim() : null;
  const archived = query.archived === true;

  const cacheable = !q && !archived && !cursor;
  if (cacheable && listCache && Date.now() - listCache.at < LIST_TTL_MS) {
    return { threads: listCache.value, nextCursor: listCache.nextCursor };
  }

  const res = await codexClient().call<{ data?: RawThread[]; nextCursor?: unknown }>("thread/list", {
    limit,
    // ⚠️ 字段名是 `sortDirection`,不是 `sortDescending` —— 写错不报错,只是照默认排
    sortKey: "updated_at",
    sortDirection: "desc",
    // 三个可选筛子一律显式给 null:Codex 那边"字段不存在"与"给了 null"语义相同,
    // 但显式给出来读代码时不用回去翻 schema
    cursor,
    searchTerm: q,
    archived: archived ? true : null,
  });
  const rows = (res?.data ?? []).map(toSummary).filter((x): x is CodexThreadSummary => x !== null);
  const nextCursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : null;
  if (cacheable) listCache = { at: Date.now(), value: rows, nextCursor };
  return { threads: rows, nextCursor };
}

/** 手动失效列表缓存 —— 新建会话、改完名、归档、跑完一轮之后用,免得刚做的事要等 20 秒才看得见 */
export function invalidateThreadList(): void {
  listCache = null;
}

/**
 * Codex 的原话 → 使用者看得懂的话。
 *
 * ⚠️ 只翻译**确知**的那两条,其余原样带出去。乱翻译比不翻译更糟:他会拿着
 * 一句被改写过的、搜不到的话来问。
 */
function humanizeCodexError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/already has an active writer/i.test(raw)) {
    return "这条会话正开在 Codex 桌面端(或另一个进程里),先去那边关掉再归档";
  }
  if (/no rollout found/i.test(raw)) {
    return "这条会话还没落过盘,现在归档不了";
  }
  return raw;
}

/**
 * 改会话名。
 *
 * ⚠️ 方法名是 **`thread/name/set`** —— schema 的**文件名**叫 `ThreadSetNameParams`,
 * 照着文件名猜成 `thread/setName` 会被回一句 `unknown variant `thread/setName`…`
 * (探针踩过,见 `probe-codex-thread.mjs`)。
 *
 * 空串 = 抹掉名字。Codex 这一栏是 `string` 不是 `string | null`(给不了 null),
 * 而空串在 `toSummary` 里会被规范化成 `null` → 界面回落到摘要那行,正好是
 * Claude 那边「恢复默认名」的意思。
 */
export async function renameThread(id: string, name: string): Promise<void> {
  await codexClient().call("thread/name/set", { threadId: id, name });
  invalidateThreadList();
}

/**
 * 归档 / 取消归档。
 *
 * ⚠️ **Codex 桌面端正开着的会话归档不了** —— 它会回 `already has an active writer`。
 * 那是 Codex 自己的一道锁(防两个写入方打架),不是我们的用法错,所以转成人话再抛。
 */
export async function setThreadArchived(id: string, archived: boolean): Promise<void> {
  try {
    await codexClient().call(archived ? "thread/archive" : "thread/unarchive", { threadId: id });
  } catch (err) {
    throw new Error(humanizeCodexError(err));
  }
  invalidateThreadList();
}

/**
 * 一条会话的**元信息**(名字、cwd、时间),不含历史。
 *
 * `readThread` 用它,`codex/artifacts.ts` 也用它 —— 后者要 cwd 才能把
 * `fileChange` 里的相对路径解析成绝对路径。所以是 export 的。
 */
export async function readThreadSummary(id: string): Promise<CodexThreadSummary> {
  const res = await codexClient().call<{ thread?: RawThread }>("thread/read", { threadId: id });
  const s = res?.thread ? toSummary(res.thread) : null;
  return s ?? { id, name: null, cwd: null, createdAt: null, updatedAt: null, preview: "" };
}

/**
 * 一条会话的历史,一次一页。
 *
 * `before` 就是上一次返回的 `olderCursor`(原样带回来,别解析它)。
 * 不给 = 取**最新**那一页。
 *
 * ⚠️ 拿法必须是 `sortDirection: "desc"` —— 见 `ITEM_PAGE` 上面那段。
 * 取回来之后**在内部翻成正序**再交给 `messagesOfEntries`:那个函数靠"相邻助手条目
 * 并进同一条消息"来避免一次回答碎成十几个气泡,而它假设输入是**时间正序**的。
 */
export async function readThread(id: string, before?: string | null): Promise<CodexThreadDetail> {
  const [thread, page] = await Promise.all([
    readThreadSummary(id),
    codexClient().call<{ data?: CodexItemEntry[]; nextCursor?: unknown }>("thread/items/list", {
      threadId: id,
      limit: ITEM_PAGE,
      // ⚠️ 不给这一项就是升序 = 最早那几条(方向反掉的元凶)
      sortDirection: "desc",
      cursor: before ?? null,
    }),
  ]);
  const entries = page?.data ?? [];
  const olderCursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
  return {
    thread,
    // 倒着取的,翻回时间正序再映射
    messages: messagesOfEntries([...entries].reverse()),
    // ⚠️ 判据是**游标**而不是"这一页取满了":取满但恰好到头时游标是 null,
    // 那时候再说"还有更早的"会让界面多出一个点了没反应的按钮
    truncated: olderCursor !== null,
    olderCursor,
  };
}

// ---------------------------------------------------------------- 活着的那些

interface PendingApproval {
  /** 给手机看的 id。**与 Codex 那边的请求 id 无关** —— 那个由 `client.ts` 的回包负责 */
  reqId: string;
  method: string;
  params: Record<string, unknown>;
  /** 手机回答时用它兑现(Codx 要的是返回值,不是我们主动回包) */
  settle: (value: unknown) => void;
  timer: NodeJS.Timeout;
}

interface LiveThread {
  id: string;
  sinks: Set<FrameSink>;
  busy: boolean;
  /** 当前这条助手消息已经攒下的块。`turn/completed` 之后清空 */
  blocks: ChatBlock[];
  /** 本轮有没有正在流式输出的文本块(用来决定要不要在收尾时补一条 message) */
  streaming: boolean;
  pending: Map<string, PendingApproval>;
  /**
   * 累计 token(Codex 的 `total.totalTokens`)。
   *
   * 跟着 `state` 帧走而不是单独一帧,理由与 Claude 那边**同一条**:它是**状态**,
   * 断了重连要能立刻拿到真值 —— 靠一帧一帧累加的话,切一次屏 "已消耗 N tokens"
   * 就永久停在上次那个数上。
   */
  tokens: number | null;
}

const live = new Map<string, LiveThread>();

function liveOf(id: string): LiveThread {
  let t = live.get(id);
  if (!t) {
    t = {
      id,
      sinks: new Set(),
      busy: false,
      blocks: [],
      streaming: false,
      pending: new Map(),
      tokens: null,
    };
    live.set(id, t);
  }
  return t;
}

export function subscribe(threadId: string, sink: FrameSink): () => void {
  const t = liveOf(threadId);
  t.sinks.add(sink);
  return () => {
    t.sinks.delete(sink);
    // ⚠️ **不在这里清 live 条目**:那一轮可能还在跑,清掉就丢帧了。
    // 真正的清理交给 `turn/completed`(见下)。
  };
}

/** 这条 thread 现在有几个手机在看。通知那边用它决定"要不要弹"(有人看着就不弹) */
export function watcherCount(threadId: string): number {
  return live.get(threadId)?.sinks.size ?? 0;
}

function fanout(t: LiveThread, frame: ServerFrame): void {
  for (const sink of t.sinks) {
    try {
      sink(frame);
    } catch {
      // 一个订阅者坏了不该拖垮别人
    }
  }
}

function stateFrame(t: LiveThread): ServerFrame {
  const frame: Extract<ServerFrame, { t: "state" }> = { t: "state", busy: t.busy };
  // 还没有数字时**不带这个字段**(而不是给 0)—— 界面据此判断"要显示哪一行",
  // 给 0 会让头部一直挂着一句"已消耗 0 tokens"
  if (t.tokens !== null) frame.tokens = t.tokens;
  return frame;
}

/** 接入时要的东西:一条 `state` 真值 + 所有未决审批(补发) */
export function snapshotFor(threadId: string): ServerFrame[] {
  const t = liveOf(threadId);
  const frames: ServerFrame[] = [stateFrame(t)];
  for (const p of t.pending.values()) frames.push(approvalFrame(p));
  return frames;
}

/**
 * 当前状态那一帧的**真值**。
 *
 * ⚠️ 心跳必须用它,不能自己编一个 `busy: false` —— 那会让界面在"正在跑"的时候
 * 每隔 15 秒闪一下空闲(与 Claude 那边 `state` 帧存在的理由是同一个:
 * 状态类的东西不能靠帧去推,要定期给真值)。
 */
export function currentState(threadId: string): ServerFrame {
  return stateFrame(liveOf(threadId));
}

// ---------------------------------------------------------------- 帧:通知 → 我们的帧

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function onNotification(method: string, params: unknown): void {
  const p = (params ?? {}) as Record<string, unknown>;
  const threadId = typeof p.threadId === "string" ? p.threadId : null;
  if (!threadId) return;
  const t = live.get(threadId);
  if (!t) return; // 没人看着这条 —— 不攒帧(历史随时能重读,不需要回放缓冲)

  switch (method) {
    case "item/agentMessage/delta": {
      const delta = typeof p.delta === "string" ? p.delta : "";
      if (!delta) return;
      t.streaming = true;
      fanout(t, { t: "assistant_delta", text: delta });
      return;
    }

    case "item/completed": {
      const item = p.item as CodexItem | undefined;
      if (!item || typeof item !== "object") return;
      const blocks = blocksOfItem(item);
      if (blocks.length === 0) return;
      // 助手侧的条目并进当前这条助手消息;用户消息不该从这条流里冒出来
      // (那是我们自己发出去的,手机本地已经有回显了)
      if (item.type === "userMessage") return;
      t.blocks.push(...blocks);
      t.streaming = false;
      // ⚠️ 发**全量**而不是增量:App 那边"整条替换最后一条助手消息"最简单也最不容易错
      fanout(t, { t: "assistant_message", blocks: [...t.blocks] });
      return;
    }

    case "turn/started": {
      t.busy = true;
      fanout(t, stateFrame(t));
      return;
    }

    case "turn/completed": {
      t.busy = false;
      t.streaming = false;
      fanout(t, stateFrame(t));
      fanout(t, { t: "result", subtype: "completed" });
      // 这一轮说完了,下一轮从头攒
      t.blocks = [];
      invalidateThreadList();
      notifyTurnDone(t);
      return;
    }

    case "error": {
      const message = typeof p.message === "string" ? p.message : "Codex 报了一个错";
      fanout(t, { t: "error", message, recoverable: true });
      return;
    }

    /**
     * 用量。方法名是 `thread/tokenUsage/updated`(schema 的文件名叫
     * `ThreadTokenUsageUpdatedNotification` —— 名字对不上,别照着文件名猜)。
     *
     * 取 `total.totalTokens`(整条会话的累计),与 Claude 那边头部显示的
     * "已消耗 N tokens"同一个口径;`last` 是**这一轮**的,换成它会让数字每轮跳回去。
     */
    case "thread/tokenUsage/updated": {
      const usage = p.tokenUsage as { total?: { totalTokens?: unknown } } | undefined;
      const total = num(usage?.total?.totalTokens);
      if (total === null || total === t.tokens) return;
      t.tokens = total;
      fanout(t, stateFrame(t));
      return;
    }

    default:
      // 其余(thread/status/changed、mcpServer 状态…)先不翻译 ——
      // 列出来的这些已经够界面用了,多映射一个就多一处要跟着 Codex 变的地方
      return;
  }
}

// ---------------------------------------------------------------- 通知

/** 发一条 Codex 通知。外部推送与 App 的常驻服务**两条都发**(照 Claude 那边的做法) */
function notifyCodex(kind: "done" | "approval", title: string, body: string, link: string): void {
  void notify(title, body, link);
  // 外部推送可能压根没配,App 自己得能弹出来
  broadcastEvent({
    t: "notify",
    kind,
    title,
    body,
    link,
    // Codex 没有"运行中的进程 id"这个概念(会话由常驻的 app-server 管着),两个都留空。
    // 安卓那侧只用到 title/body/link/kind,不看这两个字段。
    runId: null,
    ccSessionId: null,
    at: new Date().toISOString(),
  });
}

/**
 * 一轮跑完了 —— 通知。
 *
 * ⚠️ **只在没人看着的时候发。** Claude 那边原来是无条件发的,于是"人正盯着屏幕等它
 * 答完"也会再震一下 —— 对手机来说那一下尤其多余:你已经看着它写完了。
 *
 * ⚠️ 而"有没有人在看"准不准**取决于探活**(`routes/codex-threads.ts` 的 `armLiveness`):
 * 手机切后台时 socket 是悄悄烂掉的,烂连接会让这里判成"有人在看" → **该弹不弹**。
 * 两处是**成对的**,少了探活就别开这个判断。
 */
function notifyTurnDone(t: LiveThread): void {
  if (t.sinks.size > 0) return;
  // 名字能查到就带上 —— 通知栏里「哪条会话」比「有一条会话」有用得多。
  // 从列表缓存里查(内存,不打接口);拿不到就用泛泛的那一句。
  const name = listCache?.value.find((x) => x.id === t.id)?.name ?? null;
  notifyCodex(
    "done",
    "Codex 任务完成",
    name ? `「${name}」跑完了一轮` : "有一条 Codex 会话跑完了一轮",
    `remotecc://session/codex/${t.id}`,
  );
}

/**
 * 有一条审批在等人点 —— 通知。
 *
 * ⚠️ **这条不能按"没人看着"之外的条件静音**:审批只 `fanout` 给订阅者,要是手机
 * 没在看,那张卡就**没有任何人收到**,而这个 turn 会一直挂到 30 分钟超时按拒绝 ——
 * 使用者**完全不知道**在等他点一下。(Claude 那边有"需要你批准"这条通知,我们原来漏了。)
 *
 * 和 `done` 一样:**有人在看就不发**(卡片就在他眼前,不用再震一下)。
 */
function notifyApproval(t: LiveThread, tool: string): void {
  if (t.sinks.size > 0) return;
  const name = listCache?.value.find((x) => x.id === t.id)?.name ?? null;
  notifyCodex(
    "approval",
    "需要你批准",
    name ? `「${name}」有一个 ${tool} 等你点` : `有一条 Codex 会话在等你批准一个 ${tool}`,
    `remotecc://session/codex/${t.id}`,
  );
}

// ---------------------------------------------------------------- 审批

/**
 * 一条 Codex 的审批请求 → 给手机看的那张卡。
 *
 * 四种请求的字段各不相同(见 `server/scripts/probe-codex-thread.mjs` 打出来的形状),
 * 这里统一成 `permission_request`:`tool` 是"要做什么",`input` 是原始载荷,
 * `diff` 是能直接看的那段文本(有就给)。
 */
function approvalFrame(p: PendingApproval): Extract<ServerFrame, { t: "permission_request" }> {
  const params = p.params;
  const command = typeof params.command === "string" ? params.command : null;
  const reason = typeof params.reason === "string" ? params.reason : null;

  let tool = "Codex";
  let diff: string | undefined;
  if (p.method === "CommandExecutionRequestApproval") {
    tool = "命令";
    diff = command ?? undefined;
  } else if (p.method === "FileChangeRequestApproval") {
    tool = "文件改动";
    diff = reason ?? undefined;
  } else if (p.method === "ApplyPatchApproval") {
    tool = "应用补丁";
  } else if (p.method === "PermissionsRequestApproval") {
    tool = "权限申请";
    diff = reason ?? undefined;
  }

  return { t: "permission_request", reqId: p.reqId, tool, input: params, diff };
}

/** Codex 的决策 ←→ 我们的三档。`cancel`(拒绝并打断)归到 deny —— 打断有单独的按钮 */
function decisionToCodex(method: string, decision: PermissionDecision, params: Record<string, unknown>): unknown {
  // ApplyPatchApproval 用的是另一套枚举(approved / approved_for_session / denied)
  if (method === "ApplyPatchApproval") {
    return {
      decision: decision === "allow" ? "approved" : decision === "always" ? "approved_for_session" : "denied",
    };
  }

  // ⚠️ PermissionsRequestApproval 的回应**不是一个 decision**,而是一份"授予的权限档案"。
  // V1 只做两档:授予 → 把请求里那份**原样**回过去;拒绝 → 给一份空的(空 = 什么都不批)。
  if (method === "PermissionsRequestApproval") {
    if (decision === "deny") return { permissions: {}, strictAutoReview: false };
    return { permissions: params.permissions ?? {}, strictAutoReview: false };
  }

  // 命令 / 文件改动:accept / acceptForSession / decline
  // (`cancel` = 拒绝并打断,这里不区分 —— 打断有单独的按钮,而且误打断比误拒绝更烦人)
  return { decision: decision === "allow" ? "accept" : decision === "always" ? "acceptForSession" : "decline" };
}

/** 认得出的四种审批。其余(`ToolRequestUserInput` 等)明确回"不认",让 Codex 走它的默认 */
const KNOWN_APPROVALS = new Set([
  "CommandExecutionRequestApproval",
  "FileChangeRequestApproval",
  "ApplyPatchApproval",
  "PermissionsRequestApproval",
]);

/**
 * Codex 问我们一件事(审批)→ 转成一张卡推给手机 → 等回答。
 *
 * ⚠️ 这里**不需要**知道 Codex 那个请求 id:`client.ts` 的 `answer()` 拿这个函数的
 * **返回值**去回包。(第一版我在这里自己造了一个 id,是多余的 —— 而且那条路上
 * "按请求授予权限"要靠一个模块级的临时变量把载荷递过去,并发两条审批就会串台。)
 */
async function handleRequest(method: string, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  const threadId = typeof p.threadId === "string" ? p.threadId : null;
  if (!KNOWN_APPROVALS.has(method) || !threadId) {
    throw new Error(`remote-cc 不处理 ${method}`);
  }

  const t = liveOf(threadId);
  const reqId = `codex-${++approvalSeq}`;

  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      t.pending.delete(reqId);
      // 超时按**拒绝**:手机掉线时不能让电脑无人值守地执行(与 Claude 那边同一条规矩)
      resolve(decisionToCodex(method, "deny", p));
    }, APPROVAL_TIMEOUT_MS);

    const pending: PendingApproval = { method, params: p, reqId, settle: resolve, timer };
    t.pending.set(reqId, pending);
    const frame = approvalFrame(pending);
    fanout(t, frame);
    // ⚠️ 没人看着就必须通知 —— 否则这张卡没有任何人收到,而 turn 会一直挂到超时按拒绝
    notifyApproval(t, frame.tool);
  });
}

/** 手机的回答。返回 false = 这个 reqId 不认识(可能已经超时了) */
export function respondApproval(reqId: string, decision: PermissionDecision): boolean {
  for (const t of live.values()) {
    const p = t.pending.get(reqId);
    if (!p) continue;
    t.pending.delete(reqId);
    clearTimeout(p.timer);
    p.settle(decisionToCodex(p.method, decision, p.params));
    return true;
  }
  return false;
}

/** 给手机看的审批 id。自己编一个就行 —— 与 Codex 那边的 id 没有关系 */
let approvalSeq = 0;

// ---------------------------------------------------------------- 动作

/** 手机发过来的一个附件。`path` 是**电脑上**的路径(App 先传到 `/api/attach` 拿到的) */
export interface CodexAttachment {
  path: string;
  name?: string;
  kind: "image" | "file";
}

/** 一次最多带几个附件。与 Claude 那边的 `MAX_IMAGES_PER_MESSAGE` 同量级 */
const MAX_ATTACHMENTS = 8;

/**
 * 附件 + 文字 → Codex 的 `input` 数组。
 *
 * 两档的形状不一样,别合并:
 * - **图**走 `localImage`(给它一个**路径** —— Codex 自己去读那张图,所以我们不用搬字节);
 * - **文件**走 `mention`(`@` 一个文件,Codex 会把它加进上下文)。
 *   ⚠️ 它**没有** `file` 那一档 —— 查过 schema,`UserInput` 的变体只有
 *   text / image / localImage / audio / localAudio / skill / mention。
 *
 * ⚠️ 顺序是**附件在前、文字在后**(与 Claude 那条链路的块顺序一致):先给材料、
 * 再给要求,模型读起来更顺。
 */
function inputOf(text: string, attachments: CodexAttachment[]): unknown[] {
  const input: unknown[] = [];
  for (const a of attachments.slice(0, MAX_ATTACHMENTS)) {
    if (a.kind === "image") {
      input.push({ type: "localImage", path: a.path });
    } else {
      input.push({ type: "mention", name: a.name || path.basename(a.path), path: a.path });
    }
  }
  if (text.trim()) input.push({ type: "text", text });
  return input;
}

/**
 * 手机发来的一串附件 —— 过一道窄化。
 *
 * ⚠️ 它**不是**权限边界(设备本来就能通过 `/api/fs` 读整台机器),只是一道形状闸门:
 * 路径必须是字符串且是绝对的,免得把 `undefined` / 相对路径递给 Codex 之后得到一个
 * 看不懂的报错。
 */
export function attachmentsFrom(raw: unknown): CodexAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: CodexAttachment[] = [];
  for (const item of raw) {
    const o = item as { path?: unknown; name?: unknown; kind?: unknown };
    if (typeof o?.path !== "string" || !o.path) continue;
    if (!path.isAbsolute(o.path)) continue;
    out.push({
      path: o.path,
      name: typeof o.name === "string" && o.name ? o.name : undefined,
      kind: o.kind === "image" ? "image" : "file",
    });
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

export async function startTurn(
  threadId: string,
  text: string,
  attachments: CodexAttachment[] = [],
): Promise<void> {
  await assertNoCodexDesktopWriter(threadId);
  await codexClient().call("thread/resume", { threadId, excludeTurns: true });
  const t = liveOf(threadId);
  if (t.busy) throw new Error("此会话已有一轮正在运行");
  t.blocks = [];
  t.busy = true;
  fanout(t, stateFrame(t));
  try {
    await codexClient().call("turn/start", { threadId, input: inputOf(text, attachments) });
  } catch (error) {
    t.busy = false; fanout(t, stateFrame(t)); throw error;
  }
  invalidateThreadList();
}

export async function interruptTurn(threadId: string): Promise<void> {
  await codexClient().call("turn/interrupt", { threadId });
}

/**
 * 新建一条 Codex 会话,可选地立刻说第一句。
 *
 * ⚠️ 这里**不设** `approvalPolicy` / `sandbox` —— 用 Codex 自己的默认(会问、有沙箱),
 * 而审批由这一层推给手机(见 `handleRequest`)。把它设成"不问"就等于绕开了刚建好的那道闸。
 */
export async function startThread(cwd: string, text: string | null): Promise<string> {
  const res = await codexClient().call<{ thread?: { id?: string } }>("thread/start", { cwd });
  const id = res?.thread?.id;
  if (!id) throw new Error("Codex 没有返回新会话的 id");
  invalidateThreadList();
  if (text && text.trim()) await startTurn(id, text);
  return id;
}

// ---------------------------------------------------------------- 装配

let wired = false;

/** 把这一层挂到 Codex 客户端上。第一次用到时挂一次 */
export function ensureWired(): void {
  if (wired) return;
  wired = true;
  const c = codexClient();
  c.onRequest(handleRequest);
  c.onNotification(onNotification);
}
