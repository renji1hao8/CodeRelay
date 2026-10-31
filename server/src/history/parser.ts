import fs from "node:fs";
import path from "node:path";
import type { ChatBlock, ChatMessage, StoredImage, TitleSource } from "@remote-cc/shared";
import { config } from "../config.ts";
import { storeImage } from "../images.ts";

/**
 * 一次 API 响应的用量(账单用)。
 *
 * ⚠️ 身份是 **`msgId`**(= jsonl 里的 `message.id`),不是条目 —— 同一个响应会按
 * content block 落成多条 assistant 条目,`usage` 每条都原样重复(实测最多 5 次)。
 * 去重放在库里做(主键 + INSERT OR IGNORE),因为跨切片的重复解析器看不见。
 */
export interface ParsedUsage {
  msgId: string;
  ts: string | null;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** usage 里的数字字段:缺失或不是数字都当 0 —— 别让账单因为一个字段变成 NaN */
function countOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface ParsedSession {
  id: string;
  /**
   * 这个会话的**起始工作目录** —— 也就是"它属于哪个项目"。
   *
   * ⚠️ **不是"这段切片里最后一条带 `cwd` 的条目"**,尽管 jsonl 里每条都带 `cwd`。
   * 那个字段是 CLI 进程**当下**的 shell 工作目录:agent 在会话里 `cd` 到哪,之后写的
   * 条目就带哪个。实测一个会话里能出现十几种(含 `…\node_modules`、`C:\Users\Example`、
   * 以及 `/e/远程cc` 这种 MSYS 拼法)。
   *
   * 拿它当身份,后果就是使用者报的那条「会话老是乱跳」:会话的分组目录等于"最后一次
   * `cd` 到哪",会话页按目录分组的树于是不停搬家,同一个项目还会因为拼法不同裂成两组。
   *
   * 所以:只有**整段是从文件头解析**时,才取**第一条**带 cwd 的条目;增量切片一律给
   * null(切片的第一条不是会话的第一条)。显式搬迁另走 `relocatedCwd`。
   */
  cwd: string | null;
  /**
   * CLI **显式**声明"这个会话搬到别处了"(`type:"relocated"` 条目)。
   *
   * 这和上面那种顺手 `cd` 的漂移不是一回事,是会话真的换项目了 —— 所以它**允许覆盖**
   * 已经存下来的起始目录。索引器那边靠它排在最前面(见 indexer 的 COALESCE)。
   */
  relocatedCwd: string | null;
  title: string | null;
  /** 标题来源。见 shared 的 TitleSource —— 索引器靠它防止标题被降级覆盖 */
  titleSource: TitleSource | null;
  lastPrompt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * **归档标记。三态,不是布尔。**
   *
   *   `true`  = 这段切片里读到了"归档"
   *   `false` = 读到了"取消归档"
   *   `null`  = 这段切片里**根本没提到**归档
   *
   * ⚠️ `false` 和 `null` 必须分得开:增量解析一段不含标记的新内容时,如果把"没提到"
   * 当成 `false`,那**已经归档的会话会被后来的每一段切片反复解除归档**。索引器那头
   * 靠这个三态决定"要不要动库里的值"(见 indexer 里那段合并说明)。
   */
  archived: boolean | null;
  /** 归档那一刻的时间。**取消归档时是 null** —— 取消了就不该留着"归档于 9 月 20 日" */
  archivedAt: string | null;
  messages: ChatMessage[];
  /** 这一段切片里读到的用量。**包含子代理的**(那也是真花钱),不去重 —— 库那头管 */
  usage: ParsedUsage[];
  nextOffset: number;
  reset: boolean;
}

export interface SessionFile {
  id: string;
  filePath: string;
}

export function listProjects(): string[] {
  if (!fs.existsSync(config.claudeProjectsDir)) return [];
  return fs
    .readdirSync(config.claudeProjectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function sessionFiles(): SessionFile[] {
  const out: SessionFile[] = [];
  for (const project of listProjects()) {
    const dir = path.join(config.claudeProjectsDir, project);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      out.push({ id: name.slice(0, -6), filePath: path.join(dir, name) });
    }
  }
  return out;
}

/**
 * CC 把"刚读了一张图"额外记成一条**独立的 user 消息**,正文就是这句占位符。
 *
 * 图本身在上一条 tool_result 里(见下面 tool_result 分支的提取),所以这条纯属
 * 重复的笔记 —— 留着的话它会冒充"使用者说的话",在界面上渲染成一个用户气泡。
 * 整条丢掉。
 */
const CC_IMAGE_NOTE = /^\[Image: original \d+x\d+, displayed at \d+x\d+\./;

function flattenToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) return String((b as { text: unknown }).text);
        return "";
      })
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

/**
 * 把 Messages API 形状的 image 块落盘,换成只带路径的 ChatBlock。
 *
 * 只认 base64 源。url 源要联网下载,而历史回放是同步扫 jsonl 的路径,
 * 在解析器里发网络请求会把「打开会话」变成不可预期的慢操作。
 */
function storedImageBlock(source: unknown): StoredImage | null {
  if (!source || typeof source !== "object") return null;
  const s = source as Record<string, unknown>;
  if (s.type !== "base64") return null;

  const mediaType = typeof s.media_type === "string" ? s.media_type : "";
  const data = typeof s.data === "string" ? s.data : "";
  if (!mediaType || !data) return null;

  const stored = storeImage(mediaType, data);
  if (!stored) return null;
  return { mediaType: stored.mediaType, path: stored.path, size: stored.size };
}

/**
 * 把消息 content 归一化成 ChatBlock[]。
 *
 * ⚠️ 这个函数有**副作用**:遇到 image 块会往 uploads/ 落盘。它本该是纯解析,
 * 之所以把落盘放在这里,是因为它是实时流(runner)和历史回放共用**唯一**的
 * 归一化点 —— 放在别处就意味着两条路要各写一遍,而它们已经因此发散过一次。
 * 落盘是内容寻址的,幂等,重复解析同一条消息不会重复写。
 */
export function blocksFromContent(role: "user" | "assistant", content: unknown): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  if (typeof content === "string") {
    const trimmed = content.trim();
    // 命中「CC 的读图笔记」就一个字都不产出 —— 调用方会因此整条跳过这条消息
    if (trimmed && !CC_IMAGE_NOTE.test(trimmed)) blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;

  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string" && b.text.trim()) blocks.push({ type: "text", text: b.text });
        break;
      case "thinking":
        if (typeof b.thinking === "string" && b.thinking.trim()) {
          blocks.push({ type: "thinking", text: b.thinking });
        }
        break;
      case "tool_use":
        blocks.push({
          type: "tool_use",
          id: String(b.id ?? ""),
          name: String(b.name ?? ""),
          input: b.input ?? null,
        });
        break;
      case "tool_result": {
        // ⚠️ 工具结果里可能带图。Read 一张图的返回就是这种形状:content 是个数组,
        // 里面**只有一个 image 块、没有 text**。而 flattenToolResult 只认 text,
        // 于是图被整个丢掉,界面上只剩一张空的结果卡 —— 这正是"图看不见"的原因。
        //
        // 图挂在**这个结果块上**,不另起 image 块:它是这次调用的产出,脱离
        // "哪次调用"之后就成了对话里一个没人认领的气泡。
        const images: StoredImage[] = [];
        if (Array.isArray(b.content)) {
          for (const part of b.content) {
            if (!part || typeof part !== "object") continue;
            const p = part as Record<string, unknown>;
            if (p.type !== "image") continue;
            const img = storedImageBlock(p.source);
            if (img) images.push({ mediaType: img.mediaType, path: img.path, size: img.size });
          }
        }
        blocks.push({
          type: "tool_result",
          toolUseId: b.tool_use_id == null ? null : String(b.tool_use_id),
          text: flattenToolResult(b.content),
          isError: b.is_error === true,
          ...(images.length > 0 ? { images } : {}),
        });
        break;
      }
      case "image": {
        const img = storedImageBlock(b.source);
        if (img) blocks.push({ type: "image", ...img });
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

/**
 * 斜杠命令在 jsonl 里是一条 role:"user" 的记录 —— 正文是三个 XML 标签拼的信封。
 *
 * ⚠️ 标签顺序**不止一种**,实测两种都出现过:
 *
 *   A) `<command-message>init</command-message>` + `<command-name>/init</command-name>`
 *   B) `<command-name>/compact</command-name>` + `<command-message>compact</command-message>`
 *      + `<command-args></command-args>`
 *
 * 旧实现只认 A(它断言正文必须以 `<command-message>` 开头),于是 B 类的命令
 * **整段 163 字的 XML 原封不动漏进对话**,在手机上渲染成"我自己打的一串尖括号"。
 * 表现极具误导性:同一个功能,`/init` 压得干干净净,`/compact` 却漏 —— 差别只在标签顺序。
 */
function compactCommand(text: string): string | null {
  const t = text.trimStart();
  const hasName = t.startsWith("<command-name>");
  const hasMessage = t.startsWith("<command-message>");
  if (!hasName && !hasMessage) return null;

  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(t)?.[1]?.trim() ?? "";
  const message = /<command-message>([\s\S]*?)<\/command-message>/.exec(t)?.[1]?.trim() ?? "";
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? "";

  // 只有 name 带斜杠;message 是不带斜杠的命令名。B 类里两者都在,A 类里也都在,
  // 但万一只剩 message(没见过,防御性兜底),补一个斜杠比丢掉整条好。
  const cmd = name || (message ? `/${message}` : "");
  if (!cmd) return null;

  // ⚠️ 护栏:信封**只由这几个标签组成**。把标签整个挖掉之后还剩正文,说明这
  // 不是信封而是人在正常说话(比如在讨论命令格式),那就原样留着,别去动它。
  const leftover = t
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .trim();
  if (leftover) return null;

  return args ? `${cmd} ${args}` : cmd;
}

/**
 * 把"真人说的话"和本地命令的脚手架从**同一条**消息里剥开。
 *
 * ⚠️ 为什么光有 `isMeta` / `turnCompanion` 不够:那些标记只加在"**整条**都是脚手架"
 * 的条目上。而实测到这么一条真实条目 —— 使用者先打一句、紧接着在 App 里跑了几个
 * 本地命令、又打一句,CLI 把这几段**合并成一条** role:"user" 落盘,中间夹着
 * caveat / 信封 / stdout,**这一条上什么标记都没有**:
 *
 * ```
 * 还是不行
 * <local-command-caveat>Caveat: …</local-command-caveat>
 *
 * E:\RemoteCC\server\data\exports\20260919163201-我的提问.md
 * <command-name>/compact</command-name>
 *             <command-message>compact</command-message>
 *             <command-args></command-args>
 * <local-command-stdout>Compacted </local-command-stdout>
 *
 * 这些在历史消息中全会导进来
 * ```
 *
 * 按标记判身份在这条上完全失效,只能按内容剥。剥完什么都不剩 → 整条丢掉。
 */
function stripLocalCommandScaffolding(text: string): string {
  return text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    // 挖走标签会留下空行(信封本身占了整行),逐行去首尾空白再把连续空行收成一个
    .replace(/[^\S\n]*\n[^\S\n]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 系统塞进对话的信封 —— 以 role:"user" 落盘,但**不是使用者说的任何话**。
 *
 * 目前见到两种:
 *   - `<task-notification>`:子代理(Agent 工具)跑完后,系统把它的报告作为一条
 *     user 消息塞回来。不处理的话,App 里会显示成"我自己发了一大段勘察报告"。
 *   - `<system-reminder>`:注入的上下文提示(工具用法、环境、memory 等)。
 */
const SYSTEM_ENVELOPE = /^\s*<(task-notification|system-reminder)[\s>]/;

function firstHumanText(messages: ChatMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = m.blocks.find((b) => b.type === "text");
    if (text && text.type === "text" && text.text.trim()) return text.text.trim();
  }
  return null;
}

/** 按字节游标增量解析。jsonl 是权威源,解析失败的单行跳过而不中断整个文件 */
export function parseSession(filePath: string, fromOffset = 0, id = path.basename(filePath, ".jsonl")): ParsedSession {
  const result: ParsedSession = {
    id,
    cwd: null,
    relocatedCwd: null,
    title: null,
    titleSource: null,
    lastPrompt: null,
    createdAt: null,
    updatedAt: null,
    archived: null,
    archivedAt: null,
    messages: [],
    usage: [],
    nextOffset: fromOffset,
    reset: false,
  };

  let buf: Buffer;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "r");
    const size = fs.fstatSync(descriptor).size;
    if (fromOffset > size) { result.reset = true; fromOffset = 0; }
    buf = Buffer.alloc(size - fromOffset);
    let read = 0;
    while (read < buf.length) {
      const count = fs.readSync(descriptor, buf, read, buf.length - read, fromOffset + read);
      if (!count) break;
      read += count;
    }
    buf = buf.subarray(0, read);
  } catch {
    return result;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const slice = buf;
  const lastNewline = slice.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    result.nextOffset = fromOffset;
    return result;
  }

  const text = slice.subarray(0, lastNewline + 1).toString("utf8");
  result.nextOffset = fromOffset + lastNewline + 1;

  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let lastPrompt: string | null = null;
  /** 刚读到一条斜杠命令信封 —— 下一条(展开后的提示词)要跳过。只对紧邻的下一行生效 */
  let skipExpansion = false;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // 上一行是斜杠命令信封 → 这一行是它展开后的提示词,要跳过。
    // 取出来就立刻清掉,保证只影响紧邻的这一行(中间插了别种 entry 也不会误伤后面的消息)。
    const skipThisLine = skipExpansion;
    skipExpansion = false;

    const ts = typeof entry.timestamp === "string" ? entry.timestamp : null;
    if (ts) {
      if (!result.createdAt) result.createdAt = ts;
      result.updatedAt = ts;
    }
    /**
     * ⚠️ **取第一条,而且只在整段是从文件头开始时取** —— 见 `ParsedSession.cwd` 的说明。
     *
     * 这里原来是 `if (typeof entry.cwd === "string") result.cwd = entry.cwd;`,也就是
     * 后来的覆盖前面的。而 jsonl 每条都带 `cwd`、那个值是 CLI **当下**的 shell 工作目录,
     * 于是"会话属于哪个项目"变成了"它最后一次 cd 到哪" —— 使用者报的「会话老是乱跳」。
     *
     * `fromOffset === 0` 这个条件不能省:增量切片的第一条**不是**会话的第一条,拿它当
     * 起始目录只会换个方式继续漂。(`fromOffset` 在上面被重置成 0 过,那种情况本来就该
     * 重头读,所以这里直接用它是对的。)
     */
    if (fromOffset === 0 && result.cwd === null && typeof entry.cwd === "string") {
      result.cwd = entry.cwd;
    }
    // 显式搬迁(CLI 说"这个会话搬到别处了")和顺手 cd 不是一回事,允许它覆盖;后出现的赢
    if (entry.type === "relocated" && typeof entry.relocatedCwd === "string") {
      result.relocatedCwd = entry.relocatedCwd;
    }

    switch (entry.type) {
      case "custom-title":
        /**
         * 自定义会话名。
         *
         * ⚠️ **空值是"把自定义名去掉"的显式标记**,不是"没有标题"。手机上的
         * 「恢复默认名」写的就是一条 `customTitle: ""` —— 没有这个约定的话,一旦
         * 改过名(custom 档位最高,永远不被覆盖),使用者就再也回不到 AI 起的名字了。
         *
         * 它得在**整段解析**(`fromOffset === 0`)里才算得准:回落值(AI 名 / 首句话)
         * 来自文件靠前的条目,增量切片里根本没有。调用方(改名的路由)清楚这一点。
         */
        if (typeof entry.customTitle !== "string") break;
        customTitle = entry.customTitle.trim() || null;
        break;
      /**
       * **归档标记** —— 我们自己往文件尾追加的那种条目(见 `routes/sessions.ts::/:id/archive`)。
       *
       * 为什么不是搬文件:一个会话其实是**两份东西**(`<uuid>.jsonl` + 同名目录,里面
       * 有 `subagents/` 和 `tool-results/`),搬要搬两处、还得另存一份"原来在哪";而更要命
       * 的是索引器的幽灵清理拿 `file_path` 去比 `sessionFiles()`,加上 `size === offset`
       * 那条早退会让**字节数没变的文件不刷新 `file_path`** —— 搬走的会话会被判成幽灵、
       * 连 messages 一起删掉,下一轮再从零整份重建。加标记不动路径,只是让文件变长,
       * 增量解析必然跑到,什么都不用改。
       *
       * `archivedAt` 取 `at`(我们写进去的),没有就退到这一条的 `timestamp`。
       */
      case "custom-archived": {
        if (typeof entry.archived !== "boolean") break;
        result.archived = entry.archived;
        result.archivedAt = entry.archived
          ? typeof entry.at === "string"
            ? entry.at
            : ts
          : null;
        break;
      }
      case "ai-title":
        if (typeof entry.aiTitle === "string") aiTitle = entry.aiTitle;
        break;
      case "last-prompt":
        if (typeof entry.lastPrompt === "string") lastPrompt = entry.lastPrompt;
        break;
      case "system": {
        // CLI 的**本地命令**记录。
        //
        // ⚠️ 斜杠命令不一定落在 user 条目上:实测只有"未知 / 不展开"的命令走这条
        // (`/xyz` → content 是命令本身,外加一条 `<local-command-stdout>Unknown command…`),
        // 而 `/init` `/push` `/compact` 走的是 user 信封。旧实现只认 user 信封,
        // 于是这类命令在历史里**彻底消失** —— 手机上重建后一条都看不到。
        if (entry.subtype !== "local_command") break;
        const content = typeof entry.content === "string" ? entry.content : "";
        const body = content.trim();
        // 命令的**输出**只是 CLI 的回声,不进历史:实时流那边已经把它当文本增量
        // 推给手机了,再入一次库就重复了。
        if (!body || body.startsWith("<local-command-stdout>")) break;
        result.messages.push({
          uuid: typeof entry.uuid === "string" ? entry.uuid : null,
          role: "user",
          ts,
          blocks: [{ type: "text", text: body }],
        });
        break;
      }
      case "user":
      case "assistant": {
        // 用量(账单)先抽 —— **要放在下面 isSidechain 的跳过之前**:子代理的往返不该
        // 出现在对话里,但那些 token 是真花的,漏掉它账单会偏小。
        // ⚠️ 同一条响应会按 content block 落成多条条目、`usage` 每条都重复,这里**不去重**
        // (解析器一次只看一个切片,跨切片的重放它看不见)—— 去重在库里(message.id 主键)。
        if (entry.type === "assistant") {
          const msg = entry.message as
            | { usage?: Record<string, unknown>; id?: string; model?: string }
            | undefined;
          const u = msg?.usage;
          if (u && typeof msg?.id === "string" && msg.id) {
            result.usage.push({
              msgId: msg.id,
              ts,
              model: typeof msg.model === "string" ? msg.model : null,
              input: countOf(u.input_tokens),
              output: countOf(u.output_tokens),
              cacheRead: countOf(u.cache_read_input_tokens),
              cacheWrite: countOf(u.cache_creation_input_tokens),
            });
          }
        }

        if (entry.isSidechain === true) break; // 子代理内的往返,手机端不展示
        const message = entry.message as { role?: string; content?: unknown } | undefined;
        if (!message) break;
        const role = entry.type === "user" ? "user" : "assistant";
        const uuid = typeof entry.uuid === "string" ? entry.uuid : null;

        // ⚠️ 下面这一段专治"role 是 user、但根本不是使用者说的话"。
        //
        // jsonl 在这类条目上带了**权威标记**,比"正文长得像不像"可靠得多。
        // 上一版是纯正文启发式,漏了两头:压缩摘要(既不带尖括号、也不是人打的)
        // 被当成我的提问;`/compact` 因为标签顺序不同而没被识别,原文整段漏出来。
        if (role === "user") {
          // 压缩摘要:是 user,但属于上下文注入。**不能丢**(丢了会话断片),
          // 只是不能渲染成"我的提问"气泡 —— 立一个独立块类型,界面画成折叠系统条。
          if (entry.isCompactSummary === true) {
            const text = typeof message.content === "string" ? message.content : "";
            if (text.trim()) {
              result.messages.push({ uuid, role: "user", ts, blocks: [{ type: "compact_summary", text }] });
            }
            break;
          }
          // isMeta:系统塞进来的 —— 读图占位符、`<local-command-caveat>`、Stop hook 注入。
          if (entry.isMeta === true) break;
          // turnCompanion:斜杠命令**展开后的提示词正文**(模板本身),不是使用者打的字。
          // 这一条替代了原来那段"跳过紧邻下一行"的位置启发式 —— 启发式对"中间插了
          // 别的条目"和"没展开的命令"都会漏。
          if (entry.turnCompanion === true) break;
        }

        let blocks = blocksFromContent(role, message.content);
        if (blocks.length === 0) break;

        if (role === "user") {
          const joined = blocks
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("\n")
            .trim();

          const cmd = compactCommand(joined);
          if (cmd) {
            // 斜杠命令:压成「/命令 参数」一行,并标记跳过紧跟的展开
            blocks = [{ type: "text", text: cmd }];
            skipExpansion = true;
          } else if (skipThisLine) {
            // 兜底:turnCompanion 万一没标上,仍然按位置关系跳过展开后的提示词
            break;
          } else if (SYSTEM_ENVELOPE.test(joined)) {
            // <task-notification>(子代理的报告)/ <system-reminder>(注入的上下文)
            break;
          } else {
            // 脚手架和真话混在同一条里 —— 这条上没有 isMeta 标记,只能按内容剥
            const cleaned = stripLocalCommandScaffolding(joined);
            if (!cleaned) break;
            if (cleaned !== joined && blocks.length === 1 && blocks[0]?.type === "text") {
              blocks = [{ type: "text", text: cleaned }];
            }
          }
        }

        result.messages.push({ uuid, role, ts, blocks });
        break;
      }
      default:
        break;
    }
  }

  result.title = customTitle ?? aiTitle ?? firstHumanText(result.messages)?.slice(0, 80) ?? null;
  result.titleSource = customTitle ? "custom" : aiTitle ? "ai" : result.title ? "prompt" : null;
  result.lastPrompt = lastPrompt ?? firstHumanText([...result.messages].reverse()) ?? null;
  return result;
}
