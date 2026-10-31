// 由 mobile/scripts/sync-protocol.mjs 从 packages/shared/src 生成,请勿手改。
import type { ShellChunk, ShellHistoryEntry, ShellJob } from "./shell.ts";

/**
 * 权限模式。
 *
 * ⚠️ 四个档位是**从松到紧**排的,界面上的顺序也照这个来:
 * readonly(只看)→ ask(每步确认)→ acceptEdits(自动编辑)→ bypass(全自动)。
 *
 * ⚠️ `bypass` **不是** SDK 的 `bypassPermissions`。那个要额外打开
 * `allowDangerouslySkipPermissions`,而且一开就**连 `canUseTool` 都不再被调用** ——
 * 而 `AskUserQuestion` 恰好走的就是那条通道(它得把答案并进 updatedInput 回传),
 * 关了等于让模型自己去猜答案。所以这一档是**服务端在 canUseTool 里放行**(见 runner.ts):
 * 效果一样是"不问",但问答题还能照常推到手机上。
 */
export type PermissionMode = "readonly" | "ask" | "acceptEdits" | "bypass";
/** 界面上的顺序即这里的顺序。四档的文案集中在 App 的 ModePicker 里,这里只管合法性 */
export const PERMISSION_MODES: PermissionMode[] = ["readonly", "ask", "acceptEdits", "bypass"];

/** 认不出来的值(老版本残留、手改过的 SecureStore)一律当 false */
export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as string[]).includes(v);
}

export type PermissionDecision = "allow" | "always" | "deny";

/**
 * 审批超时时间:超时按 deny 处理,防止手机掉线后 PC 无人值守地执行。
 *
 * ⚠️ **别改短。** 这条是"手机掉线后 PC 无人值守地执行"的唯一一道闸,但它只该
 * 兜住"没人应答",不该惩罚"人在认真看"。2026-09-20 从 5 分钟提到 30 分钟:
 * 使用者的原话是「在回答选择并提出建议的情况下时间不够用」—— 而 5 分钟的代价
 * 恰好落在最该慢的那一类审批上(读 diff、翻上下文、写一段"为什么拒绝"的说明)。
 * 拒绝是默认结局,**晚一点失败没有任何越权风险**。
 *
 * 注意另一侧:手机重连时后端会按 `listPending()` 把未决审批**补发**一遍,所以
 * 拉长超时不会让审批在切屏后凭空消失。
 */
export const PERMISSION_TIMEOUT_MS = 30 * 60_000;

/**
 * 上面那个值的分钟数。界面上的「N 分钟不响应会自动拒绝」一律引用它 ——
 * 别在各处手写 "5 分钟"(改常量时手写的那几处不会跟着变)。
 */
export const PERMISSION_TIMEOUT_MINUTES = Math.round(PERMISSION_TIMEOUT_MS / 60_000);

/**
 * **提权请求**等手机应答的上限。
 *
 * ⚠️ 比普通审批(30 分钟)短得多,只有 5 分钟。两者的性质不同:普通审批等的是
 * "这一轮要不要继续",等久了只是慢;**提权请求等的是一个正卡在半路的脚本** ——
 * 它占着"要动手做事"的位置,而电脑那头(以及 agent 那一轮工具调用)全都停在那儿。
 *
 * 超时同样按**拒绝**处理,拒绝永远是安全的那一侧。
 */
export const ELEVATED_TIMEOUT_MS = 5 * 60_000;

/** 界面上的「N 分钟不响应会自动拒绝」一律引用它,别手写 5 */
export const ELEVATED_TIMEOUT_MINUTES = Math.round(ELEVATED_TIMEOUT_MS / 60_000);

/**
 * `AskUserQuestion` 的选项。该工具走的是 canUseTool 审批通道(不是 request_user_dialog),
 * 所以问题与选项跟着 permission_request 的 input 一起来。
 */
export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

/** 从 AskUserQuestion 的 input 里窄化出问题列表;形状不对时返回 null */
export function parseQuestions(input: unknown): QuestionSpec[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: QuestionSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string" || !Array.isArray(q.options)) return null;
    const options: QuestionOption[] = [];
    for (const opt of q.options) {
      if (!opt || typeof opt !== "object") continue;
      const o = opt as Record<string, unknown>;
      if (typeof o.label !== "string") continue;
      options.push({
        label: o.label,
        description: typeof o.description === "string" ? o.description : undefined,
        preview: typeof o.preview === "string" ? o.preview : undefined,
      });
    }
    if (options.length === 0) return null;
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out.length > 0 ? out : null;
}

/** 手机发来的一张图片。data 是不带 `data:` 前缀的裸 base64 */
export interface ImageAttachment {
  mediaType: string;
  data: string;
}

/**
 * 单条消息最多带几张图。
 *
 * 放在共享包里而不是两边各写一份:服务端按它截断、手机端按它限制选择,
 * 两处不一致时表现会很怪(选了 8 张、发出去只剩 6 张,而且没有任何提示)。
 */
export const MAX_IMAGES_PER_MESSAGE = 6;

/**
 * 归一化后的消息块,历史回放与实时流共用同一形状。
 *
 * 图片只带**电脑上的落盘路径**,不带 base64:jsonl 里的 base64 动辄几百 KB,
 * 每个会话列表/详情请求都背着它走隧道是纯浪费。手机拿 path 去请求
 * `/api/fs/download`(那条路由已经有 token 鉴权和 inline 语义),图片还能被
 * RN 的 Image 组件按需缓存。
 *
 * 唯一的例外是**用户自己刚发出的那条**:服务端此刻还没收到图,自然没有路径,
 * 所以手机在本地回显时把 path 填成自己的设备 URI(file:// / content://)。
 * 两者不可能混淆 —— 设备 URI 永远不是有效的电脑路径。
 */
/**
 * 已经落盘的图片:只带电脑上的绝对路径,不带 base64 ——
 * 一屏几十张图的话,base64 会把 WebSocket 帧撑到几 MB。
 */
export interface StoredImage {
  name?: string;
  mediaType: string;
  path: string;
  size: number;
}

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "file"; path: string; name: string; size: number }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  /**
   * 工具结果。
   *
   * `images` 是**这次调用产出的图** —— 最典型的是 Read 读到一张图。它们必须挂在
   * 结果上,不能当成独立的 image 块往消息里塞:那样图会脱离"是哪次调用产生的"
   * 这个上下文,飘在对话里像个没人认领的气泡。
   */
  | { type: "tool_result"; toolUseId: string | null; text: string; isError: boolean; images?: StoredImage[] }
  /**
   * 上下文压缩后由 CLI 注入的摘要。
   *
   * ⚠️ 它在 jsonl 里是 **role:"user"** 的条目,照原样渲染就会变成"我自己发了一大段
   * 总结"的右对齐气泡 —— 实测踩到过,而且因为摘要动辄上万字,那个气泡能占满好几屏。
   *
   * 它是**上下文的一部分,不能丢**(丢了会话就断片),但必须以"系统条"的形态出现:
   * 一条默认折叠的窄条,想看再展开。所以单独立一个块类型,而不是塞进 text。
   */
  | { type: "compact_summary"; text: string }
  | ({ type: "image" } & StoredImage);

export interface ChatMessage {
  /** Stable source position for desktop history; never a client arrival time. */
  sequence?: number;
  uuid: string | null;
  role: "user" | "assistant";
  ts: string | null;
  blocks: ChatBlock[];
}

export type ArtifactKind = "image" | "markdown" | "code" | "report" | "diff";

export interface ArtifactSummary {
  id: string;
  sessionId: string;
  path: string;
  kind: ArtifactKind;
  size: number;
  createdAt: string;
  hasThumb: boolean;
}

export type ClientFrame =
  | {
      t: "user_message";
      text: string;
      /**
       * **Claude 专用**:图片的字节。后端把它们落到内容寻址的图库里,再当内容块喂给 SDK。
       */
      images?: ImageAttachment[];
      /**
       * **Codex 专用**:附件在**电脑上的路径**。
       *
       * ⚠️ 与上面那条 `images` 是两套,别混:Claude 那条链路收的是**字节**(Agent SDK 的
       * 内容块只认 image,没有"从路径读图"这个说法),而 Codex 的 `turn/start` 收的是
       * **路径**(`localImage` / `mention`)—— 所以 App 得**先把文件传到电脑上**
       * (`POST /api/attach`)、拿到路径再发这一帧。
       *
       * 两条都用 `user_message` 这个帧名是故意的:对 App 来说"发一句话带点东西"是同一件事,
       * 差别只在后端的投递方式。
       */
      codexAttachments?: { path: string; name?: string; kind: "image" | "file" }[];
    }
  | {
      t: "permission_response";
      reqId: string;
      decision: PermissionDecision;
      reason?: string;
      /** AskUserQuestion 专用:{ 问题文本: 答案 };多选的答案用逗号分隔 */
      answers?: Record<string, string>;
    }
  | { t: "interrupt" }
  | { t: "set_mode"; mode: PermissionMode }
  /**
   * 回答一条**提权请求**(见下面 ServerFrame 里的 `elevated_request`)。
   *
   * `approve` = 允许电脑上那个提权执行器动手。**这一步是不可撤销的**,而且它比普通
   * 审批危险得多:普通审批放行的是一次工具调用,这个放行的是"以管理员身份做事"。
   */
  | { t: "elevated_response"; reqId: string; decision: "approve" | "deny" }
  /**
   * ---- 命令框(`/api/shell` 那条流。和会话那条**完全独立**)----
   *
   * 用途是"**必须由使用者自己跑、agent 不能或不应该代替**的那些操作"(他的原话)。
   * 所以权限是"自由执行 + 审计留痕":不拦、只记。
   */
  | { t: "shell_start"; command: string; cwd?: string }
  /** 往正在跑的那条命令的 stdin 写(等价于在终端里打字)。`newline` 默认 true */
  | { t: "shell_stdin"; jobId: string; data: string; newline?: boolean }
  /** 关掉 stdin(等价 Ctrl+D)—— 不少 CLI 把它当"我说完了,收工" */
  | { t: "shell_eof"; jobId: string }
  /** **打断**(等价 Ctrl+C)。⚠️ 它是**硬终止**,和真 Ctrl+C 不等价,见后端说明 */
  | { t: "shell_stop"; jobId: string }
  /**
   * 要另一条作业已有的输出。
   *
   * 接入时那份快照只带**一条**作业的输出(同时最多跑 3 条,全带上会很占带宽),
   * 切到另一条时用它要。回答是一帧新的 `shell_snapshot`。
   */
  | { t: "shell_attach"; jobId: string };

export type ServerFrame =
  | {
      t: "system";
      subtype: "init";
      sessionId: string;
      model: string;
      cwd: string;
      /**
       * Bash 工具**实际用的那个 shell**(由后端报,App 不写死)。
       *
       * 起因是使用者的一句疑问:「看不到 agent 用的什么命令行工具…不知道用的是
       * cmd/git bash/pwsh7/pwsh5/wsl 还是别的」。答案是**只有一个**:Claude Code 的
       * Bash 工具永远拉起同一个 shell(Windows 上是 Git for Windows 的 bash)——
       * 它没有"用 PowerShell 跑"这种工具,能到 pwsh/cmd/wsl 的唯一途径是**在命令里
       * 显式调**。所以卡片上标这个值,再由 App 看命令的第一个词叠一个「嵌套 xxx」角标。
       */
      shell?: string;
      /**
       * CLI 自己报的「只在本机终端里才有意义」的斜杠命令(如 exit / statusline)。
       *
       * ⚠️ 这份名单**不能由我们猜**:SDK 的 init 帧里就有,而且它的注释写着
       * "Phone/remote UIs should hide these from command menus"。手机上打这些命令
       * 发进 CLI 只会卡住或报错(它们是交互式的),所以 App 拦下来、给一句像样的说明。
       */
      terminalSlashCommands?: string[];
    }
  | { t: "assistant_delta"; text: string }
  | { t: "assistant_message"; blocks: ChatBlock[] }
  | { t: "tool_result"; id: string; content: string; isError: boolean }
  | { t: "permission_request"; reqId: string; tool: string; input: unknown; diff?: string }
  | { t: "artifact"; artifact: ArtifactSummary }
  | { t: "mode_changed"; mode: PermissionMode }
  /**
   * 这一轮到底跑没跑完 —— 手机每次接入时后端推的**真值**。
   *
   * 为什么要它:`busy` 原来只能从帧里推(`assistant_delta` 置忙、`result` 置闲),
   * 而帧**丢了就永远不知道**。切屏期间那一轮结束了、`result` 帧没有任何人接 ——
   * 回来界面就一直显示"正在思考",新发的消息也石沉大海(使用者的原话:
   * 「明明已经停了,但我这里还显示正在思考并且我的新输入会被阻断」)。
   *
   * 和 `mode_changed` 一个道理:**状态类的东西不能只靠帧**,每次接入推一份快照。
   * `tokens` 顺手带上,免得"已消耗 N tokens"在重连后停在上次的值上。
   */
  | {
      t: "state";
      busy: boolean;
      tokens?: number;
      /**
       * 距离**最后一次有输出**过了多少毫秒。
       *
       * 用来回答"它还在跑、还是卡住了" —— 光看 `busy` 分不出这两种:agent 跑一个长时间
       * 不出声的东西(定时任务、好几分钟不回话的工具调用)时 `busy` 一直是 true,而界面
       * 只能显示"正在思考",人没法判断该不该打断。
       *
       * ⚠️ 后端**每 15 秒推一次**这一帧(忙闲都推),它同时是"我还活着"的心跳:
       * 它停了 = 后端没了、或这条流死了。心跳走**连接本地**的发送路径,不写帧日志、
       * 也**不刷** `lastActivityAt` —— 否则心跳自己会把自己的静默时间归零,这个字段
       * 就永远是 0,等于没做。
       */
      idleMs?: number;
      /**
       * 帧编号(接入时那一帧有意义;心跳也带,值会涨)。
       *
       * 客户端记下它,下次重连时在流的 URL 上带 `?since=` 报回来,服务端就能**精确补**
       * 它错过的那些帧 —— 这是"重连不必重拉历史"的前提:能补齐,就不用再花十几秒去拉
       * 那 44KB(实测这条链路只有 ~3 KB/s)。
       */
      seq?: number;
      /**
       * **重连补发够不够** —— 只在接入时那一帧出现。
       *
       * `true` = "你错过的那段我这儿都还有,已经补给你了" → 客户端**不必重拉历史**。
       * `false` = 中间有一段已经被挤掉了 → 客户端**必须**重拉,不能装作续上了。
       *
       * ⚠️ **缺这个字段(老后端)按 `false` 处理**,也就是照旧重拉。安全的默认在这边:
       * 猜错的方向要是"以为齐了、其实缺了一段",那正是坑 40 那种最难查的形状。
       */
      catchupComplete?: boolean;
    }
  /**
   * **手机那一下点击的收据**(审批与提权各一路,见 `kind`)。
   *
   * 为什么需要:回执帧原来是 fire-and-forget —— 服务端**只在出错时**回一帧,成功时
   * App 唯一能看到的证据是"卡片自己消失了"。而 `ws.send()` 返回 true 之后 socket
   * 立刻死掉的话,帧根本没到,卡片却已经关了。使用者的原话是「我点了、卡片也没了,
   * 但电脑那边像没收到」—— 接着只能等超时,表现出来就是"要点好几次"。
   *
   * 所以现在**成功也回执**:App 点完先进"提交中",收到这一帧才关卡片;等不到就退回
   * 可点状态并明说。宁可让人再点一次,也不要"看起来成功了其实没有"。
   *
   * `result` 的三态和 `cc/permissions.ts::RespondResult` 一致:
   *   - `ok`      收到了,这一轮继续
   *   - `expired` 那张卡已经超时作废(电脑那边按"拒绝"走完了)
   *   - `unknown` 认不出这个 reqId(多半是自己或另一台设备已经点过)
   * 后两者含义**相反** —— 别合成一句"已超时或已被处理"(那是使用者抱怨过的
   * 「警告逻辑有点不对」)。`message` 里带服务端给的说法,App 直接显示、别自己拼,
   * 免得两边的措辞各自漂移。
   *
   * ⚠️ 有了这一帧,**就别再为这两种情况另发 `error` 帧** —— 那条路会顺手把 App 的
   * `busy` 置 false,而审批超时被拒时这一轮**还在跑**(模型接着往下走),置闲是错的。
   */
  | {
      t: "approval_ack";
      kind: "permission" | "elevated";
      reqId: string;
      result: "ok" | "expired" | "unknown";
      /** `result !== "ok"` 时给的使用者能看懂的说法,由服务端给 */
      message?: string;
    }
  /**
   * 这一轮的结束帧。
   *
   * `tokens` 是**累计**消耗(这个 query() 会话至今),取自 SDK 的 `modelUsage` ——
   * 那是唯一正确的口径:另一个 `usage` 字段只算主 agent 循环、且按轮计,不含 Task
   * 子代理与辅助调用。只累计 input + output,**不含缓存读写**:缓存命中量会把数字撑到
   * 几十倍,那不是"消耗"而是"重复读取"。
   *
   * 手机端拿它显示「已消耗 N tokens」,取代原来的美元数。**老后端不发这个字段**,
   * 收到 undefined 就什么都不显示(所以新 App 配旧后端也不会出错)。
   */
  | { t: "result"; subtype: string; costUsd?: number; durationMs?: number; tokens?: number }
  | { t: "error"; message: string; recoverable: boolean }
  | { t: "upstream"; ccSwitch: boolean; mihomo: boolean }
  /**
   * ---- 命令框的回帧(走 `/api/shell` 那条流,不在会话流里)----
   *
   * ⚠️ 这一组**不做回放、也不进帧日志**。理由是命令这边**没有第二份来源**:
   * 聊天那边必须包一层 `replay` 是因为回放的内容和 App 手上的历史**重叠**,而命令这边
   * 只有后端一个环形缓冲 —— 所以"对齐"就是把快照整份给它,不存在认亲问题。
   */
  | { t: "shell_started"; job: ShellJob }
  | { t: "shell_output"; jobId: string; chunk: ShellChunk }
  | { t: "shell_exit"; job: ShellJob }
  /** `jobId` 为 null 表示"这条命令根本没跑起来"(比如 pwsh 找不到) */
  | { t: "shell_error"; jobId: string | null; message: string; recoverable: boolean }
  /**
   * 接上流时的第一帧:所有作业 + 某个作业已有的输出 + 命令历史。
   *
   * `chunks` 按 `mergeShellChunks` 与 App 手上那份对齐(见 shared/shell.ts)。
   */
  | {
      t: "shell_snapshot";
      jobs: ShellJob[];
      /** 快照里那份 chunks 属于哪个作业(没有就是 null) */
      jobId: string | null;
      chunks: ShellChunk[];
      history: ShellHistoryEntry[];
      /** pwsh 的路径。**找不到时是 null**,界面上要直接说清楚而不是让每条命令都失败 */
      pwsh: string | null;
    }
  /**
   * **重连时补发的帧** —— 里面那帧的内容是"已经发生过的",不是新内容。
   *
   * ⚠️ 为什么要单独包一层,而不是原样重发:手机手上有**两份**来源 ——
   * 打开会话时拉的那份历史(`seed`),和重连时后端补的那段帧。两者覆盖的时间段
   * **是重叠的**:帧里那段输出,CLI 早就写进 jsonl、也早就被索引进历史了。
   * 原样重发的后果就是同一段话在界面上出现两遍(使用者报的「agent 的话重复两遍甚至
   * 多遍」:退出重进解决不了 —— 因为重进又补一遍;而 `/exit` 再重进会起一条**全新的
   * 流**,帧日志是空的、没有回放,所以看着就"好了")。
   *
   * 而光靠客户端去重分不出这两种情况:一段一模一样的正文,既可能是**回放的重复**,
   * 也可能是模型**真的把同一句话说两遍**。包这一层就把话说明白了:
   * 里面那帧如果是你已经有的内容,那就是同一条消息,别再追加一个气泡。
   *
   * 判据落在 `messageMerge.ts::identityOf` 上(正文 / 工具 id / 块形状三档指纹),
   * 与"补历史时让真身认领本地回显"用的是同一套身份。
   */
  | { t: "replay"; frame: ServerFrame }
  /**
   * **提权请求**:电脑上有个动作需要管理员权限,等你批准。
   *
   * ## 为什么是"请求"而不是"转接"
   *
   * UAC 那个框**转不到手机上** —— 它跑在 Windows 的 secure desktop 上,只有 Windows
   * 进程能访问那块桌面,普通用户态进程连截屏、注入输入都被禁止(这是 UAC 的设计目标:
   * 必须有一个物理机器前的、可信的人点那一下)。所以这里做的不是"转发那个框",而是
   * **替掉它**:电脑上预先注册一个以最高权限运行的计划任务(提权执行器),它动手之前
   * 先问手机;手机点了"批准"它才做。
   *
   * ## 它和普通审批的关系
   *
   * 走的是**另一条通道**(不是 `permission_request`),因为:
   *   - 它不属于某一个会话里的某一次工具调用 —— 发起方是电脑上那个独立的脚本
   *   - 风险等级不同:界面必须**红色高亮**,而且不该和普通审批混在一张卡里
   *
   * ## ⚠️ 它的安全边界(说清楚,别当成硬闸门)
   *
   * 拦住的是"agent 自作主张提权"这一类:它跑不出这个通道 —— 执行器只认手机上批过的
   * 请求。**拦不住**的是"有东西冒充手机来批准":后端和 agent 跑在同一台机器、同一个
   * 用户下,能读这台机器上任何文件的东西(包括被提示注入的 agent)理论上也能走一遍
   * 配对流程拿到 token,然后自己点"批准"。要堵死那一条,批准必须由**手机侧持有的
   * 私钥**签名(私钥只存在手机的安全存储里,电脑上读不到)—— 那是下一步的事,
   * 现在没有做。
   *
   * 所以它的定位是:**把"悄悄提权"变成"必须在手机上按一下,而且留痕"**。
   */
  | {
      t: "elevated_request";
      reqId: string;
      /** 动作的机器名(电脑上那个白名单里的键) */
      action: string;
      /** 动作的人话名字,例如「把证书装进受信任的根」 */
      title: string;
      /**
       * 具体内容 —— 要装哪个证书、要跑哪条命令。
       *
       * ⚠️ **这是数据,不是指令。** 里面的文字来自发起方(可能被提示注入影响),
       * 界面上只当普通文本显示、等宽字体呈现,绝不能当命令去执行。
       */
      detail: string;
      /** 谁发起的(工作目录)+ 它自己说的原因 */
      caller: string;
      reason: string;
    };
