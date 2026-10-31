import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ChatBlock, ChatMessage, StoredImage } from "../shared";
import { theme, toolKindLabel, toolKindOf, type ToolKind } from "../theme";
import { ToolCard, ToolResult } from "./ToolCards";
import { toolIntent } from "../toolIntent";

type TextBlock = Extract<ChatBlock, { type: "text" }>;
type ToolUseBlock = Extract<ChatBlock, { type: "tool_use" }>;
type ToolResultBlock = Extract<ChatBlock, { type: "tool_result" }>;

/** 组里的一次工具调用:调用本身 + 它收到的全部结果 */
interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  results: { text: string; isError: boolean; images?: StoredImage[] }[];
}

type RenderItem =
  | { kind: "message"; key: string; message: ChatMessage }
  | { kind: "tools"; key: string; entries: ToolEntry[] };

/**
 * 一轮对话。一条用户消息是界线,其后到下一个用户消息之前的全部内容都算 AI 对这一轮的回复。
 *
 * 为什么要这一层:AI 答一轮会产生"一段话 + 一堆工具调用 + 又一段话"这样的碎块,
 * 全部平铺出来像一堆独立气泡,读起来断断续续。按轮切开之后能用**一个框**兜住整轮,
 * 一眼能看出"这是它对我那句话的完整回答"。
 */
export type Turn =
  | { kind: "user"; key: string; message: ChatMessage }
  | { kind: "assistant"; key: string; items: RenderItem[] };

export function groupTurns(items: RenderItem[]): Turn[] {
  const turns: Turn[] = [];
  let cur: RenderItem[] = [];

  const flush = () => {
    if (cur.length === 0) return;
    turns.push({ kind: "assistant", key: `turn-${cur[0]!.key}`, items: cur });
    cur = [];
  };

  for (const it of items) {
    if (it.kind === "message" && it.message.role === "user") {
      flush();
      turns.push({ kind: "user", key: it.key, message: it.message });
    } else {
      cur.push(it);
    }
  }
  flush();
  return turns;
}

/**
 * 把消息流折成"文本"与"工具组"两种渲染项。
 *
 * 为什么要折:实时流会把**每个** tool_result 单独 append 成一条 user 消息
 * (见 useSessionStream 的 tool_result 分支),而一次工具调用又是先 use 后 result,
 * 于是一轮任务轻松产生几十条消息、几十张卡片,在手机上要划很久。
 *
 * 结果先按 toolUseId 建索引再遍历,所以不对"result 出现在 use 之后"这种顺序有依赖。
 */
export function groupMessages(messages: ChatMessage[]): RenderItem[] {
  const resultByTool = new Map<string, { text: string; isError: boolean; images?: StoredImage[] }[]>();
  const knownToolIds = new Set<string>();

  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === "tool_use") {
        knownToolIds.add(b.id);
      } else if (b.type === "tool_result" && b.toolUseId) {
        const list = resultByTool.get(b.toolUseId) ?? [];
        list.push({ text: b.text, isError: b.isError, images: b.images });
        resultByTool.set(b.toolUseId, list);
      }
    }
  }

  const items: RenderItem[] = [];
  let pending: ToolEntry[] = [];

  // 组的边界就是"下一个文本块" —— 一段话之后连着的一串工具调用算一组
  const flush = () => {
    if (pending.length === 0) return;
    const first = pending[0];
    items.push({ kind: "tools", key: `tools-${first ? first.id : items.length}`, entries: pending });
    pending = [];
  };

  messages.forEach((m, mi) => {
    const textBlocks = m.blocks.filter((b): b is TextBlock => b.type === "text");
    const toolUses = m.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const toolResults = m.blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");

    // 纯结果消息:内容已按 toolUseId 归到对应工具上了,不单独成项。
    // 例外是找不到对应 tool_use 的结果(历史被分页截断),那种要兜底渲染,免得结果凭空消失。
    // 图现在挂在结果块**里面**,所以跟着一起走,这里不用再单独照顾。
    if (toolResults.length > 0 && textBlocks.length === 0 && toolUses.length === 0) {
      const orphans = toolResults.filter((b) => !b.toolUseId || !knownToolIds.has(b.toolUseId));
      if (orphans.length > 0) {
        flush();
        items.push({
          kind: "message",
          key: m.uuid ?? `m${mi}`,
          // role 强制改成 assistant。带 tool_result 的消息在协议里虽然是 "user",
          // 但它**不是使用者说的话** —— 照原样发出去会被 groupTurns 判成用户消息,
          // 渲染成右对齐的用户气泡。
          message: { ...m, role: "assistant", blocks: orphans },
        });
      }
      return;
    }

    // 保留"给人看"的块:text、image,以及压缩摘要。
    // ⚠️ compact_summary 必须在这里 —— 它是上下文的一部分(见 MessageBubble 的说明),
    // 漏掉的话整条会被下面 `kept.length > 0` 判掉,压缩摘要直接从对话里消失。
    // tool_use 归到下面的折叠组,tool_result 已在上面按 toolUseId 归位了。
    const kept = m.blocks.filter(
      (b) => b.type === "text" || b.type === "image" || b.type === "file" || b.type === "compact_summary",
    );

    if (kept.length > 0) {
      flush();
      items.push({
        kind: "message",
        key: m.uuid ?? `m${mi}`,
        // ⚠️ 这里以前写的是 `blocks: textBlocks` —— 只留文本,**把图片块丢了**。
        // 后果有两个:
        //   1. 手机上发的图在对话里既没有缩略图、也没有任何"带了附件"的标记(#12)
        //   2. **只发图不配文字**时 textBlocks 为空,整条消息连气泡都不出现
        // (顺带也保护了 text 为空、只剩图的极端情况。)
        message: { ...m, blocks: kept },
      });
    }

    for (const b of toolUses) {
      pending.push({
        id: b.id,
        name: b.name,
        input: b.input,
        results: resultByTool.get(b.id) ?? [],
      });
    }
  });

  flush();
  return items;
}

function summarize(entries: ToolEntry[]): string {
  const counts = new Map<ToolKind, number>();
  for (const e of entries) {
    const k = toolKindOf(e.name).kind;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => `${toolKindLabel(k)} ${n}`).join(" · ");
}

/**
 * 折叠起来的一串工具调用。点一下展开,里面还是原来那些卡片(各自还能再展开参数/结果)。
 *
 * ⚠️ **三种高亮的判据(别再靠"有没有结果"单独判,那是个 bug)**:
 *
 * | 样子 | 含义 |
 * |---|---|
 * | 红 | 这一组里有调用**报错**了 |
 * | 琥珀 | 这一组**正在跑**(还有调用没拿到结果),而且它是**最新的一组**、会话此刻正忙 |
 * | 灰 | 已经跑完了 |
 *
 * 2026-09-20 修的是琥珀那一档。原来的判据只有"组里有没有调用没拿到结果",于是
 * **历史会话里也会出现琥珀色** —— 使用者原话:「我发现一些历史对话中的工具组也是
 * 琥珀色的」。原因是配不上对的那种 `tool_use` 永久存在:一次被中断的调用、被解析器
 * 按 `isMeta` 丢掉的结果、分页截断……它们的结果永远不会来,于是那一组**永远显示在跑**。
 *
 * 所以加了 `live`:**只有最新的一组、且会话正忙,才可能是在跑**。历史里
 * (`stream.busy === false`)一律按"跑完了"画。
 */
export function ToolGroup({
  entries,
  bare,
  live,
  shell,
}: {
  entries: ToolEntry[];
  bare?: boolean;
  /** 这一组是最新的那一组、且会话此刻正忙(由 ChatScreen 算,见上面那张表) */
  live?: boolean;
  /** Bash 工具用的那个 shell,转给组内的命令卡片(见 ToolCard 的说明) */
  shell?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const failed = entries.some((e) => e.results.some((r) => r.isError));
  const running = live === true && entries.some((e) => e.results.length === 0);
  const accent = failed ? theme.color.danger : running ? theme.color.accent : theme.color.textDim;
  const descriptions = [...new Set(entries.map(e => toolIntent(e.name, e.input).description).filter(Boolean))];

  return (
    <View style={[styles.wrap, bare && styles.wrapBare]}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={({ pressed }) => [
          styles.card,
          { backgroundColor: pressed ? theme.color.toolGroupBgPress : theme.color.toolGroupBg },
          failed && { borderColor: theme.color.danger },
        ]}
      >
        <Ionicons
          name={failed ? "alert-circle-outline" : running ? "ellipsis-horizontal-circle-outline" : "layers-outline"}
          size={15}
          color={accent}
        />
        <View style={styles.heading}><Text style={styles.description} numberOfLines={2}>{descriptions[0] || summarize(entries)}</Text>
        <Text style={[styles.summary, { color: accent }]} numberOfLines={1}>{descriptions.length ? summarize(entries) : `${entries.length} 项操作`}{running ? " · 进行中" : failed ? " · 有操作失败" : ""}{descriptions.length > 0 && entries.length > 1 ? ` · 另 ${entries.length - 1} 项` : ""}</Text></View>
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={13}
          color={theme.color.textFaint}
        />
      </Pressable>

      {expanded ? (
        <View style={styles.body}>
          {entries.map((e) => (
            // 同一个工具自己的框和结果是挨着的,它们之间也是 6
            <View key={e.id} style={styles.entry}>
              <ToolCard name={e.name} input={e.input} dense bare shell={shell} />
              {e.results.map((r, i) => (
                <ToolResult key={i} text={r.text} isError={r.isError} images={r.images} dense bare />
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // 折叠态只是一行摘要,上下不该再留出跟整段正文一样的气口
  // 上下都收成 6:上方那 12 是消息自己的下边距,用负 margin 拉回一致
  wrap: { marginTop: -6, marginBottom: 6, paddingHorizontal: theme.space(3) },
  /** 已经在"一轮"的大框里了:留白由大框统一给,这里不再各留一份 */
  wrapBare: { marginTop: 0, marginBottom: 0, paddingHorizontal: 0 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(2),
    paddingVertical: theme.space(2),
  },
  heading: { flex: 1, gap: theme.space(1) },
  summary: { fontSize: theme.font.size.xs },
  description: { color: theme.color.textDim, fontSize: theme.font.size.sm, lineHeight: 20 },
  body: { marginTop: theme.space(1), paddingLeft: theme.space(3), borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.color.border, gap: theme.space(3) },
  entry: { gap: theme.space(1), paddingBottom: theme.space(2) },
});
