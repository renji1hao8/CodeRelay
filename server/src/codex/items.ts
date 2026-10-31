import type { ChatBlock, ChatMessage } from "@remote-cc/shared";

/**
 * Codex 的 item → 我们的 `ChatMessage` / `ChatBlock`。
 *
 * ## 为什么是纯函数、单独一个文件
 *
 * 这份映射是这个功能里**最容易错、又最难看出来**的一块:错了的表现是"某个工具调用
 * 没显示"或者"多了一堆空行",而要发现它得真跑一轮。抽成纯函数就能用用例钉住。
 *
 * ## 这里是**照着真数据**写的,不是照着 schema
 *
 * 两者的差别很大,踩过一次:`reasoning` 在 schema 里有 `content` 与 `summary` 两个字段,
 * 看着该映射成 `thinking`;而实际数据里**两个都是空数组**(推理默认不暴露文本),
 * 照 schema 写会渲染出几十行空白 —— 实测某真实会话 100 个条目里 45 个是它。
 * 改这份映射之前,先去看一眼 `server/scripts/probe-codex-thread.mjs` 打出来的真实分布。
 */

/** 一个 Codex item。只列我们用到的字段,其余原样留着 */
export interface CodexItem {
  type?: unknown;
  id?: unknown;
  [k: string]: unknown;
}

/**
 * `thread/items/list` 的一条。
 *
 * ⚠️ item 是**嵌在 `item` 字段里**的,外层还有 turnId 与时间戳 ——
 * 直接读顶层 `.type` 会永远拿到 undefined(第一版就这么错了)。
 */
export interface CodexItemEntry {
  turnId?: unknown;
  item?: CodexItem | null;
  startedAtMs?: unknown;
  completedAtMs?: unknown;
}

/**
 * 明确**不显示**的类型。
 *
 * 单个列出来而不是"只显示认识的、其余丢掉":那样的话 Codex 加一个新类型时它会
 * **静默消失**,而"看不见的缺失"最难发现。所以规则反过来 ——
 * **列出来的噪声丢掉,其余一律渲染成一个通用行**,新类型至少看得见。
 */
const NOISE = new Set([
  "reasoning", // 实测 summary/content 都是空的(推理不暴露文本)—— 见文件头
  "sleep",
  "hookPrompt",
  "subAgentActivity",
  "enteredReviewMode",
]);

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const raw = (item: CodexItem, key: string): unknown => item[key];

/**
 * 一条 item → 若干块。
 *
 * 返回**空数组**表示这条不显示(噪声,或者本来就没有可显示的内容)。
 */
export function blocksOfItem(item: CodexItem): ChatBlock[] {
  const type = str(item.type) ?? "";
  const id = str(item.id) ?? `codex-${type}`;
  if (NOISE.has(type)) return [];

  switch (type) {
    case "userMessage": {
      const text = contentText(raw(item, "content"));
      return text ? [{ type: "text", text }] : [];
    }

    case "agentMessage":
    case "plan": {
      const text = str(raw(item, "text"));
      return text ? [{ type: "text", text }] : [];
    }

    case "commandExecution": {
      const command = str(raw(item, "command")) ?? "";
      const cwd = str(raw(item, "cwd"));
      const output = str(raw(item, "aggregatedOutput")) ?? "";
      const exitCode = num(raw(item, "exitCode"));
      const status = str(raw(item, "status"));
      const description = str(item.description) ?? str(item.justification) ?? str(item.reason);
      // 非零退出码与 status=failed 都算失败;两者都可能缺,缺了就当成功
      const isError = status === "failed" || (exitCode !== null && exitCode !== 0);
      return [
        { type: "tool_use", id, name: "command", input: { command, cwd, ...(description ? { description } : {}) } },
        { type: "tool_result", toolUseId: id, text: output, isError },
      ];
    }

    case "fileChange": {
      const changes = Array.isArray(raw(item, "changes")) ? (raw(item, "changes") as unknown[]) : [];
      const files = changes
        .map((c) => (c && typeof c === "object" ? str((c as { path?: unknown }).path) : null))
        .filter((p): p is string => !!p);
      const status = str(raw(item, "status"));
      return [
        { type: "tool_use", id, name: "apply_patch", input: { changes } },
        {
          type: "tool_result",
          toolUseId: id,
          // 一句话说清楚改了几个文件 —— 详细内容在 tool_use 的 changes[].diff 里
          text: files.length ? `改动 ${files.length} 个文件:\n${files.join("\n")}` : "文件改动",
          isError: status === "failed",
        },
      ];
    }

    case "webSearch": {
      const query = str(raw(item, "query")) ?? "";
      const results = Array.isArray(raw(item, "results")) ? (raw(item, "results") as unknown[]) : [];
      return [
        { type: "tool_use", id, name: "web_search", input: { query } },
        { type: "tool_result", toolUseId: id, text: `搜索到 ${results.length} 条结果`, isError: false },
      ];
    }

    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall": {
      const name = str(raw(item, "tool")) ?? str(raw(item, "name")) ?? "工具";
      const err = str(raw(item, "error"));
      return [
        { type: "tool_use", id, name, input: raw(item, "arguments") ?? {} },
        { type: "tool_result", toolUseId: id, text: err ?? "", isError: !!err },
      ];
    }

    case "functionCallOutput": {
      const output = str(raw(item, "output")) ?? "";
      return [{ type: "tool_result", toolUseId: null, text: output, isError: false }];
    }

    case "imageView": {
      const path = str(raw(item, "path"));
      return path ? [{ type: "text", text: `看图:${path}` }] : [];
    }

    case "imageGeneration": {
      const saved = str(raw(item, "savedPath"));
      const failure = str(raw(item, "failure"));
      if (failure) return [{ type: "text", text: `生成图片失败:${failure}` }];
      return saved ? [{ type: "text", text: `生成了图片:${saved}` }] : [];
    }

    default: {
      // 认不出来的新类型:**渲染出来**,别静默丢掉(见 NOISE 上面的说明)
      return [{ type: "tool_use", id, name: type || "未知项", input: item }];
    }
  }
}

/** `userMessage` 的 `content` 是个数组,取其中 text 那几段拼起来 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" ? str((c as { text?: unknown }).text) : null))
    .filter((t): t is string => !!t)
    .join("\n")
    .trim();
}

export function isUserItem(item: CodexItem): boolean {
  return item.type === "userMessage";
}

/**
 * 一批 entry → 消息列表。
 *
 * 相邻的 assistant 侧 item 会被**并进同一条消息** —— 一轮里 Codex 会吐很多条
 * (reasoning 跳过之后仍有 agentMessage / commandExecution / fileChange…),
 * 一条一个气泡的话,一次回答会碎成十几个气泡。
 *
 * ⚠️ `phase` 要留着:Codex 用 `commentary`(边说边做) vs `final_answer`(最终答复)
 * 区分两种 agentMessage。全当一种的话,中间那些"我准备这么做…"会和最终答案混在一起。
 * 这里暂时不分开渲染,但**把那一段标出来**,将来要用就有。
 */
export function messagesOfEntries(entries: CodexItemEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let current: ChatMessage | null = null;

  for (const entry of entries) {
    const item = entry?.item;
    if (!item || typeof item !== "object") continue;
    const blocks = blocksOfItem(item);
    if (blocks.length === 0) continue;

    const ts = num(entry.startedAtMs);
    const iso = ts === null ? null : new Date(ts).toISOString();
    const user = isUserItem(item);

    /**
     * 只有**助手侧**的条目才并进上一条,而且只并进"上一条也是助手"的那种。
     *
     * ⚠️ 这里踩过一次,是用例抓出来的:原来的判据是 `if (user || !current)` 起新消息,
     * 于是**用户消息之后的助手条目会并进那条用户消息里** —— 表现是"助手的回答显示在
     * 我自己那个气泡里"。那个 case 断言 2 条、实际只拿到 1 条,一跑就现形。
     *
     * 用户消息**永远**起一条新的:真数据里连着两条用户消息是可能的(中途插话),
     * 并起来就看不出那是两次输入了。
     */
    const cur: ChatMessage | null = current;
    if (!user && cur && cur.role === "assistant") {
      cur.blocks.push(...blocks);
      if (!cur.ts && iso) cur.ts = iso;
      continue;
    }

    current = {
      uuid: str(item.id),
      role: user ? "user" : "assistant",
      ts: iso,
      blocks,
    };
    out.push(current);
  }

  return out;
}
