import type { ArtifactSummary, ChatMessage, PermissionMode } from "./protocol.ts";

export type DesktopProvider = "claude" | "codex";
export interface DesktopSession {
  id: string;
  provider: DesktopProvider;
  title: string;
  cwd: string | null;
  updatedAt: string | null;
  status: "idle" | "busy" | "offline" | "unknown";
  canSend: boolean;
  notice?: string;
}
export interface DesktopSessionPage { sessions: DesktopSession[]; nextCursor: string | null; notice?: string }
export interface DesktopDetail {
  session: DesktopSession;
  messages: ChatMessage[];
  olderCursor: string | null;
  fetchedAt: string;
}
export interface DesktopDelivery { requestId: string; status: "submitted" | "unknown"; notice: string; acceptedAt?: string }
export interface DesktopApproval {
  id: string; tool: string; description: string; input: unknown; canAllow: boolean;
}
export interface DesktopTask {
  id: string; description: string; status: string; canStop: boolean; summary?: string;
}
export interface DesktopControl {
  connected: boolean; canInterrupt: boolean; turnKey: string | null;
  approvals: DesktopApproval[]; tasks: DesktopTask[]; tasksKnown: boolean; notice?: string;
}
export type DesktopAction = { type: "interrupt"; turnKey: string } | { type: "approval"; requestId: string; decision: "allow" | "deny" } | { type: "stopTask"; taskId: string };
export interface DesktopActionResult { status: "confirmed" | "submitted"; notice: string }
export interface AccountQuotaRow {
  label: string; remaining?: number; used?: number; total?: number;
  remainingPercent?: number; unit?: string; resetsAt?: string | null;
}
export interface ProviderAccount {
  id: string; app: string; name: string; current: boolean;
  rows: AccountQuotaRow[]; fetchedAt: string | null; stale: boolean; error?: string;
}
export interface AccountsResponse {
  providers: ProviderAccount[];
  spending: { todayUsd: number; monthUsd: number; requests: number; tokens: number; byProvider: { name: string; app: string; costUsd: number; requests: number }[]; available: boolean };
  fetchedAt: string;
}

/**
 * 会话标题是从哪儿来的。
 *
 * 优先级 **custom > ai > prompt**:
 * - `custom` 使用者自己改的名
 * - `ai`     CC 起的标题
 * - `prompt` 都不是,拿首条用户消息顶替的 —— 界面上要把它标出来,
 *            否则"一句话"和"一个标题"看起来是一回事
 */
export type TitleSource = "custom" | "ai" | "prompt";

export interface SessionSummary {
  id: string;
  projectPath: string | null;
  title: string | null;
  /** 标题的来源。null = 连顶替的都没有(空会话) */
  titleSource?: TitleSource | null;
  lastPrompt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  /**
   * 归档了没有。归档的不出现在会话列表里(`GET /api/sessions` 默认就排除它们),
   * 要拿它们得走 `?archived=1`。见后端 `POST /api/sessions/:id/archive`。
   *
   * 可选是为了兼容:老后端不返回这个字段,`undefined` 就该当成"没归档"。
   */
  archived?: boolean;
  /** 归档那一刻(本地 ISO)。取消归档之后是 null —— 不归档了就不该留着"归档于…" */
  archivedAt?: string | null;
}

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  /** 还有更早的消息时,这是下一页的游标(传给 beforeId);否则为 null */
  olderCursor: number | null;
}

export interface HealthResponse {
  version: string;
  upstream: { ccSwitch: boolean; mihomo: boolean };
  uptimeSec: number;
  /**
   * 当前活着的 claude 会话。
   *
   * 只有这两条是"收到响应"本身证明不了的 —— 后端活着、隧道通,都由这次响应自己
   * 说明白了;而上游状态上面那两项也有了。剩下真正的新信息就是"手上压着几个会话、
   * 有没有卡在半路的",所以只加这一项,不凑数。
   *
   * `busy` 是**此刻正跑到一半**的那些 —— 它们是"卡住"的候选。手机上看到
   * "3 个会话,2 个在跑"而自己并没有在用,基本就是有进程没收拾干净。
   */
  sessions: { live: number; busy: number };
  /**
   * **只有救援模式才有这一项** —— 也就是说:这个响应来自电脑上那个独立的救援进程
   * (`server/src/rescue.ts`),**后端进程本身没在跑**。
   *
   * 正常情况它是 `undefined`,那就是"后端在跑"。手机端判"要不要显示救援那一块"
   * 就看这个字段在不在 —— 别去比 `version` 之类的,那些在救援模式下也是填得出来的。
   *
   * ⚠️ 救援响应**必须把上面那几个必填字段照填**(version/upstream/uptimeSec/sessions),
   * 否则手机上一堆 `health.upstream.ccSwitch` 这样的读法会直接崩 —— 而不是"显示得不对"。
   */
  rescue?: {
    /** 一句人话:为什么后端没在跑 */
    reason: string;
    /** boot.log 的尾部。后端连启动都没成功时,原因就在这几行里 */
    bootLogTail: string;
    /** 后端端口此刻通不通。通了说明它崩过一次又起来了,或者刚被拉起来 */
    backendPortUp: boolean;
  };
}

export interface CreateSessionRequest {
  cwd: string;
  prompt: string;
  mode: PermissionMode;
}

export interface ResumeSessionRequest {
  prompt: string;
  mode: PermissionMode;
}

export interface PairStartResponse {
  code: string;
  expiresAt: string;
  /** 手机该填的地址(公网隧道入口)。没配就是 null,得自己填 */
  publicUrl: string | null;
  port: number;
}

export interface PairClaimRequest {
  code: string;
  deviceName: string;
}

export interface PairClaimResponse {
  token: string;
  deviceId: string;
}

export interface DeviceSummary {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  mtime: string;
}

/**
 * 手机端对某个位置的写入权限。
 *
 * - `readonly` 只给看不给改
 * - `append`   能传新文件、能建目录,**不能删**;同名文件自动改名存副本
 * - `full`     能删能改
 *
 * ⚠️ 默认是 `append`,这是刻意的:手机上不该有删除键。删错了没有回收站,
 * 而用户真正想从手机做的往往是"把东西传上去",不是"清理电脑"。
 * 判定在后端(config.ts 的写模式),不是界面上的装饰 —— 服务端真的会拒。
 */
export type FsWriteMode = "readonly" | "append" | "full";

export interface FsRoot {
  path: string;
  exists: boolean;
  writeMode: FsWriteMode;
}

export interface FsRootsResponse {
  roots: FsRoot[];
}

export interface FsListResponse {
  path: string;
  parent: string | null;
  /** 这个目录所在的根是什么权限 —— 界面据此决定显示哪些写入入口 */
  writeMode: FsWriteMode;
  entries: FsEntry[];
}

export interface FsReadResponse {
  path: string;
  size: number;
  truncated: boolean;
  encoding: "utf8" | "base64";
  mime: string;
  text: string;
}

export interface DeleteIntentResponse {  confirmToken: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  expiresAt: string;
}

export interface AuditRecord {
  id: number;
  ts: string;
  deviceId: string | null;
  action: string;
  target: string | null;
  result: string;
  detail: string | null;
}

export interface ArtifactDetail extends ArtifactSummary {
  content: string | null;
  diff: string | null;
}

/**
 * 一次 API 响应的用量 —— 账单的基本单位。
 *
 * ⚠️ 一个响应在 jsonl 里会按 content block 落成**多条** assistant 条目,而 `usage`
 * 每条都原样重复(实测同一个 `message.id` 最多出现 5 次)。所以这里的身份是
 * **`message.id`**,库里拿主键 + `INSERT OR IGNORE` 去重 —— 按条目累加会把账单
 * 算成好几倍,而且一眼看不出来(数字只是偏大)。
 */
export interface UsageRow {
  ts: string;
  /** 产生这次用量的模型名;取不到就是 null */
  model: string | null;
  input: number;
  output: number;
  /** 缓存读 —— 通常只有输入价的十分之一,不算进来账单会差很多 */
  cacheRead: number;
  /** 缓存写(CLI 分 1h / 5m 两档,这里合成一个数) */
  cacheWrite: number;
}

export interface UsageResponse {
  /** 这次查询的起点(ISO)· 方便界面说明"算的是哪一段" */
  since: string;
  rows: UsageRow[];
  /** 历史数据里出现过的模型名 —— 配价时直接给使用者点选,省得手打模型名 */
  models: string[];
}

/**
 * 电脑上当前那个可供手机自更新的 APK(`GET /api/app/release`)。
 *
 * 没有这个文件时后端回 **404**,而不是回一个"版本 0" —— 那样手机得去猜 0 是不是异常。
 * 404 在 App 侧就是一句"电脑上还没有发布过新版",语义干净。
 */
export interface AppReleaseResponse {
  /**
   * 比较更新的**唯一依据**(整数)。
   *
   * ⚠️ 只跟数字比,不比 `versionName` 字符串:`0.10.0` 按字符串比会小于 `0.9.0`。
   * 只有**严格大于** App 自己的 `versionCode` 才提示更新 —— 相等是同一个包,
   * 更小是降级,两种都该静默。
   */
  versionCode: number;
  /** 只用来显示 */
  versionName: string;
  /** APK 的 SHA-256(小写十六进制)。手机下完可以核对 —— 隧道那条链多一道校验不吃亏 */
  sha256: string;
  sizeBytes: number;
  /** 发版时写的一句话;没写就是 null */
  notes: string | null;
  /** 这个 APK 是什么时候发上去的(ISO) */
  publishedAt: string;
}

/**
 * `POST /api/recovery/restart` 的回应。
 *
 * ⚠️ 它是 **202 Accepted**,不是 200 —— 后端**还没有**重启,只是排上了,过
 * `delaySec` 秒才动手。手机上的文案要照实说("已排定,10 秒后重启"),别写成"已重启":
 * 后者会让人在流断掉的那一刻以为又坏了。
 */
export interface RecoveryRestartResponse {
  ok: true;
  /** 排定多少秒后动手 */
  delaySec: number;
}

export type { ArtifactSummary, ChatMessage, PermissionMode };

/**
 * Codex(ChatGPT Plus 等)的一个额度窗口。
 *
 * ⚠️ 两个字段都可能为 `null` —— 后端不一定给窗口长度、也不一定给重置时刻。
 * 手机端要能照常显示(只画"用了多少",不画倒计时),别把它们当必填。
 */
export interface CodexQuotaWindow {
  /** 0–100 的整数 */
  usedPercent: number;
  /** 窗口长度(分钟) */
  windowMinutes: number | null;
  /** 重置时刻(unix 秒) */
  resetsAt: number | null;
}

/**
 * Codex 的额度快照 —— `GET /api/codex/quota`。
 *
 * 来源是 Codex app-server 的 `account/rateLimits/read`,**不花 token**(它是一次协议
 * 调用,不是一次模型请求)。所以手机可以放心地一点就刷新。
 */
export interface CodexQuotaResponse {
  /** 套餐(free / plus / pro / …) */
  planType: string | null;
  /** 短窗口。Plus 是 5 小时(300 分钟) */
  primary: CodexQuotaWindow | null;
  /** 长窗口。Plus 是 7 天(10080 分钟) */
  secondary: CodexQuotaWindow | null;
  /**
   * 额度余额。**原样给字符串** —— 它是精度敏感的小数,在后端转成 float 再转回来
   * 会多出或丢掉末尾几位,而这是钱。
   */
  creditBalance: string | null;
  /** 此刻普通额度是不是已经用尽(后端 `ordinaryUsageAllowed === false`) */
  blocked: boolean;
  /** 手上还有几次没用的「重置额度」(Codex 允许用它把窗口提前重置) */
  resetCredits: number;
  /**
   * 这份快照读到的时刻(ISO)。
   *
   * ⚠️ 额度是**快照**不是实时量 —— 后端那边也有缓存。手机端要把它显示出来
   * (「截至 X 分钟前」),否则使用者会以为数字是此刻的,而它在别处跑过 Codex 之后
   * 已经变了。
   */
  fetchedAt: string;
}

/**
 * 列表里的一条 Codex 会话。
 *
 * ⚠️ 它**故意不复用 `SessionSummary`**。两者的字段看着像,但语义不同:
 * `SessionSummary.projectPath` 是"会话属于哪个项目"(jsonl 首条 cwd),
 * `titleSource` 是 Claude 的标题来源分档 —— Codex 都没有。硬套的话只能填假值。
 *
 * ⚠️ **但"归档"这条已经不成立了**(2026-09-28 更正)。原来这里写着"Codex 一样都没有,
 * 硬套会让界面上出现点不动的归档",而探针实测 `thread/archive` / `thread/unarchive`
 * 与列表的 `archived` 过滤**都能用**。归档态不放在这条 summary 上,是因为列表**分两次
 * 请求**(活动一份、归档一份),而不是一条记录带个布尔。
 */
export interface CodexThreadSummary {
  id: string;
  /** Codex 自己给的名字;没有就是 null */
  name: string | null;
  cwd: string | null;
  createdAt: string | null;
  /** 最后活动(ISO)。列表按它排 */
  updatedAt: string | null;
  /** 拿不到名字时的副标题:Codex 给的摘要 */
  preview: string;
}

/**
 * `GET /api/codex/threads` 的响应。
 *
 * ⚠️ 多了一个 `nextCursor` 之后它**不再是裸数组** —— 列表能往下翻页了。
 */
export interface CodexThreadListResponse {
  threads: CodexThreadSummary[];
  /** 下一页的游标。`null` = 到头了。**不要解析它**,原样回传 */
  nextCursor: string | null;
}

export interface CodexThreadDetail {
  thread: CodexThreadSummary;
  /**
   * 历史消息。
   *
   * ⚠️ 这里已经是**归一化过的 `ChatMessage`** —— 由后端把 Codex 的 item 映射好了
   * (`server/src/codex/items.ts`)。App 不需要知道 Codex 的 item 长什么样。
   */
  messages: ChatMessage[];
  /**
   * 还在更早的内容没拿。
   *
   * 等价于 `olderCursor !== null`,留着它是为了让"要不要显示加载更早那个按钮"
   * 读起来直接 —— 真正的入口是下面那个游标。
   */
  truncated: boolean;
  /**
   * 「加载更早」的游标。`null` = 到头了,别再无谓地打接口。
   *
   * ⚠️ 它是 Codex 给的**不透明字符串**(看着像时间戳),别去解析它、也别拿它比大小 ——
   * 那是 `thread/items/list` 自己的分页态,我们只负责原样传回去。
   */
  olderCursor: string | null;
}

/**
 * `GET /api/codex/threads/:id/artifacts` 的响应 —— 这条会话动过哪些文件。
 *
 * ⚠️ 与 Claude 那条产物接口**是两条数据来源**:那边扫 jsonl,这边翻 `fileChange`
 * item。见 `server/src/codex/artifacts.ts` 的文件头。
 */
export interface CodexArtifactsResponse {
  artifacts: ArtifactSummary[];
  /**
   * 有没有**翻到头**。
   *
   * `false` = 那条会话的 item 太多,我们只翻了前几页 —— 更早的改动没算进来。
   * 界面上要照实说一句(否则"我明明改过这个文件"会看起来像丢东西)。
   */
  complete: boolean;
}
