import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type TextStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { presentUserMessage, type ChatMessage } from "../shared";
import { Markdown } from "../markdown";
import { imageUri } from "../markdown/resolver";
import { theme } from "../theme";
// 「整条就是一条斜杠命令」的判据收在 slashCommand.ts 里 —— 管画的(这里)和管路由的
// (ChatScreen)共用一份,否则两边对同一个输入会给出不同答案(见那个文件的说明)。
import { slashCommandOf } from "../slashCommand";
import { ToolCard, ToolResult } from "./ToolCards";
import { ZoomableImage } from "./ZoomableImage";
import { downloadUrlAndOpen } from "../download";

/** 长按要能触发复制,但没有回调时不必平白多包一层 Pressable */
function tappable(body: ReactNode, onLongPress?: () => void): ReactNode {
  if (!onLongPress) return body;
  return (
    <Pressable onLongPress={onLongPress} delayLongPress={350}>
      {body}
    </Pressable>
  );
}

/**
 * 命令气泡要不要"命令名 / 参数"分色 —— **真机上一有异常就把它改回 `false`**。
 *
 * 这个组件为"斜杠命令只画得出开头那个 `/`"翻过三次车,而且**只有在真机上才看得见**:
 * 第一次归罪于嵌套 Text,于是拆掉嵌套改成一色;第三次(2026-09-19)查明**拆掉嵌套并没有
 * 根治**,把命令气泡和普通气泡逐项对完之后,只剩"样式是数组还是单份"这一条差别。
 * 于是 2026-09-21 应使用者要求把分色加回来 —— 但留这个开关:改回 false 就是整条同色,
 * 一行字的事,不必重新推一遍这段历史。
 *
 * 另一条硬规矩:分色那两层都用**注册过的单份样式**(`userCmdName` / `userCmdArg`),
 * 不许数组、不许内联对象 —— 那正是第三次查出来的元凶。
 */
const SPLIT_COMMAND_COLORS = true;

/**
 * 压缩摘要。
 *
 * ⚠️ 它在 jsonl 里是 **role:"user"** 的条目,照原样渲染就成了"我自己发了一大段总结"
 * 的右对齐气泡 —— 而摘要动辄上万字,那个气泡能占好几屏,把整段对话淹掉。
 *
 * 但它属于**上下文**,不能丢(丢了会话就断片)。所以折成一条默认收起的窄条:
 * 一眼看得出"这里发生过一次压缩",想知道细节再展开。
 */
function CompactSummary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable style={styles.compactBox} onPress={() => setOpen((v) => !v)}>
      <View style={styles.compactHead}>
        <Ionicons name="archive-outline" size={13} color={theme.color.textFaint} />
        <Text style={styles.compactTitle}>上下文已压缩</Text>
        <Text style={styles.compactMeta}>{text.length} 字</Text>
        <Ionicons
          name={open ? "chevron-up" : "chevron-down"}
          size={13}
          color={theme.color.textFaint}
        />
      </View>
      {open ? (
        <Text style={styles.compactBody} selectable>
          {text}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * 单条消息。工具卡片本身在 ToolCards.tsx —— 连续的工具调用会被 ChatScreen 的
 * 分组逻辑收进 ToolGroup,这里只负责兜底渲染没被分组的那些。
 *
 * `bare` 表示外层已经有"一轮对话"的大框了,这里就不再自己画一层气泡 ——
 * 否则会出现框里套框,看起来比不合并还碎。
 */
export function MessageBubble({
  message,
  bare,
  onLongPress,
}: {
  message: ChatMessage;
  bare?: boolean;
  /** 长按 —— 交给 ChatScreen 弹复制菜单 */
  onLongPress?: () => void;
}) {
  message = presentUserMessage(message);
  const isUser = message.role === "user";
  const userImages = isUser ? message.blocks.filter(b => b.type === "image") : [];

  // 压缩摘要整条走系统条的形态,不套用户气泡
  const onlyCompact = message.blocks.every((b) => b.type === "compact_summary");
  if (onlyCompact) {
    const text = message.blocks
      .map((b) => (b.type === "compact_summary" ? b.text : ""))
      .join("\n\n");
    return <View style={styles.systemWrap}>{text.trim() ? <CompactSummary text={text} /> : null}</View>;
  }

  const onlyToolResults = message.blocks.every((b) => b.type === "tool_result");

  if (onlyToolResults) {
    return tappable(
      <View style={[styles.wrap, bare && styles.bareWrap]}>
        {message.blocks.map((b, i) =>
          b.type === "tool_result" ? (
            <ToolResult key={i} text={b.text} isError={b.isError} images={b.images} />
          ) : null,
        )}
      </View>,
      onLongPress,
    );
  }

  const content = message.blocks.map((block, i) => {
    if (block.type === "text") {
      if (!isUser) return <Markdown key={i} text={block.text} />;
      const cmd = slashCommandOf(block.text);
      if (cmd) {
        /**
         * 斜杠命令气泡。
         *
         * ⚠️ **这段历史值钱,别删。** 使用者真机上"斜杠命令只画得出开头那个 `/`"复发过
         * 三次(2026-09-19 的原话:「斜杠命令还是有概率只渲染出一个斜杠」)。第一次归罪于
         * "用嵌套 Text 只给命令名上色",于是拆掉嵌套、改成整条一色 —— 而**第三次是在
         * 已经拆掉嵌套之后复发的**,说明触发它的从来不是嵌套。把命令气泡和普通气泡逐项
         * 对完之后,只剩**"样式是数组还是单份"**这一条差别(文字、块形状、key、
         * `selectable` 全一样):数组样式每次渲染产出一个新对象,和 Fabric 文本属性
         * (run)的比对/测量撞在一起,就是那个"只画得出第一个字、后面留着高度没有字"
         * 的毛病(坑 27)。
         *
         * 所以分色回来了,但**两层都是注册过的单份样式**(`userCmdName` / `userCmdArg`),
         * 不许数组、不许内联对象。反悔开关是上面的 `SPLIT_COMMAND_COLORS`。
         *
         * 没有参数时干脆不套第二层:少一层 Text 少一分风险,空 span 也没有意义。
         */
        const args = block.text.slice(cmd.nameEnd);
        if (!SPLIT_COMMAND_COLORS || !args) {
          return (
            <UserText key={i} style={styles.userCmdText}>
              {block.text}
            </UserText>
          );
        }
        return (
          <UserText key={i} style={styles.userCmdText}>
            <Text style={styles.userCmdName}>{block.text.slice(0, cmd.nameEnd)}</Text>
            <Text style={styles.userCmdArg}>{args}</Text>
          </UserText>
        );
      }
      return (
        <UserText key={i} style={styles.userText}>
          {block.text}
        </UserText>
      );
    }
    if (block.type === "compact_summary") {
      return <CompactSummary key={i} text={block.text} />;
    }
    if (block.type === "image") {
      if (isUser) return null;
      // 手机本地回显时 path 是设备 URI,历史回放时是电脑上的路径 ——
      // imageUri 两种都认(见 markdown/resolver.ts)
      const uri = imageUri(block.path);
      if (!uri) {
        return (
          <Text key={i} style={styles.imageFallback}>
            [图片]
          </Text>
        );
      }
      return (
        <View key={i} style={styles.msgImage}>
          <ZoomableImage uri={uri} />
        </View>
      );
    }
    if (block.type === "file") {
      return <Pressable key={i} style={styles.file} accessibilityLabel={`下载 ${block.name}`} onPress={() => { const url = imageUri(block.path); if (url) void downloadUrlAndOpen(url, block.name); }}><Ionicons name="document-outline" size={20} color={theme.color.accent} /><Text style={styles.fileName} numberOfLines={2}>{block.name}</Text><Ionicons name="download-outline" size={15} color={theme.color.textFaint} /></Pressable>;
    }
    if (block.type === "tool_use") {
      return <ToolCard key={i} name={block.name} input={block.input} />;
    }
    if (block.type === "tool_result") {
      return <ToolResult key={i} text={block.text} isError={block.isError} images={block.images} />;
    }
    return null;
  });
  if (userImages.length) content.push(<View key="attachments" style={[styles.imagesRow, { width: userImages.length === 1 ? 120 : 248 }]}>{userImages.map((block, i) => { const uri = imageUri(block.path); return uri ? <View key={`${block.path}:${i}`} style={styles.userImage}><ZoomableImage uri={uri} compact /></View> : null; })}</View>);

  if (bare) {
    return tappable(<View style={styles.bareWrap}>{content}</View>, onLongPress);
  }

  return tappable(
    <View style={[styles.wrap, isUser && styles.wrapUser]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>{content}</View>
    </View>,
    onLongPress,
  );
}

/**
 * 一条消息里可复制的文字。
 *
 * 只取 text 块 —— thinking、工具调用、工具结果都是实现细节,用户要复制的是
 * "她到底说了什么"。工具结果单独有复制入口(见 ToolCards)。
 */
export function messageText(message: ChatMessage): string {
  return message.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n")
    .trim();
}

/**
 * 用户气泡的正文。
 *
 * ⚠️ 它比一个裸 `<Text>` 多干一件事:**第一帧量出自己该有多宽,第二帧把宽度写死、
 * 并多给 `USER_TEXT_SLACK_PX` 像素**。原因见那个常量的说明 —— Android 15+ 上
 * "量出来的宽度"比"排出来需要的宽度"小几像素,开头有断点的字符串会因此被断行、
 * 第二行整行被裁掉。
 *
 * 为什么要重新挂一遍(`key` 变了):宽度写死之后要保证**原生那一层的排版是按新宽度
 * 重建的**,而不是沿用第一帧那次。换 key 等于换掉那个原生 Text,最干净。
 * 第一帧量到的宽度是**对的** —— 外面那层气泡虽然按内容撑开,但 Yoga 量出来的宽度
 * 与我们需要的宽度一致(少的只是 useBoundsForWidth 那几像素)。
 */
function UserText({ style, children }: { style: TextStyle; children: ReactNode }) {
  const [pinned, setPinned] = useState(0);

  if (pinned > 0) {
    return (
      <Text key="pinned" style={[style, { width: pinned + USER_TEXT_SLACK_PX }]}>
        {children}
      </Text>
    );
  }
  return (
    <Text
      key="measuring"
      style={style}
      onLayout={(e) => setPinned(Math.round(e.nativeEvent.layout.width))}
    >
      {children}
    </Text>
  );
}

/**
 * 用户气泡正文的基准样式。
 *
 * 抽出来只为一件事:让「命令气泡」和「普通气泡」共用**同一个基准** —— 它俩只该
 * 差一个颜色,不该差"样式是数组还是单份"。理由见 `userCmdText` 的说明。
 */
const USER_TEXT = { color: theme.color.text, fontSize: theme.font.size.md, lineHeight: 24 };

/**
 * 压给正文的宽度余量(px)。
 *
 * ⚠️ 为什么必须有它 —— 2026-09-20 在真机上钉死的一条 Android 平台 bug:
 *
 * Android 15+ 默认打开了 `Paint.useBoundsForWidth`,文本**测量**按字形边界算、
 * **排版**按字宽(advance)算,于是"量出来的宽度"比"排出来需要的宽度"小几个像素。
 * 上游记录:react-native#56402(Android 15/16 文本被截断)、修复 PR #54721。
 *
 * 差这几像素本身无害(顶多溢出一点点),**但只要字符串开头存在断点机会,断行就正好
 * 落在那里**:`/compact` / `//compact` / `/zzz` 被断在斜杠之后,后面整串移到第 2 行,
 * 而气泡高度是按"一行"给的 → **只剩开头那串斜杠**。`abcd`(不可断行)与
 * `[Request interrupted by user]`(断点在 "Request" 之后,几像素够不到)都正常。
 *
 * 所以修法是让正文拿到的**可用宽度严格大于**它排出来所需的宽度,断行就不会发生。
 * 注意:靠"给气泡加内边距"是不行的 —— 气泡是按正文自身宽度撑开的,加内边距只会让
 * 气泡变宽、正文的可用宽度一点不变(这一版之前就是这么改错的)。
 */
const USER_TEXT_SLACK_PX = 6;

const styles = StyleSheet.create({
  wrap: { marginBottom: theme.space(3), paddingHorizontal: theme.space(3) },
  wrapUser: { alignItems: "flex-end" },
  bubble: { borderRadius: theme.radius.lg, padding: theme.space(3), maxWidth: "96%" },
  bubbleUser: { backgroundColor: theme.color.userBubble, maxWidth: "88%" },

  bubbleAssistant: { backgroundColor: theme.color.assistantBubble },
  userText: USER_TEXT,
  /**
   * 斜杠命令气泡的**外层**样式:定字号/行高/颜色,并作为整条一色时的全部样式。
   *
   * ⚠️ **必须是一份整的、注册过的样式**,不能写回
   * `style={[styles.userText, styles.userCmd]}`。
   *
   * 2026-09-19 第三次复发("消息气泡里斜杠命令只剩一个 `/`")时顺着差别查出来的:
   * 命令气泡和普通气泡当时**唯一**的差别就是"样式是数组"还是"样式是单份" ——
   * 文字内容、块形状、key、`selectable` 全都一样,而普通气泡一直好好的、坏的永远
   * 只有命令气泡。数组样式要走 `StyleSheet.flatten`,**每次渲染都产出一个新对象**,
   * 和 Fabric 里文本属性(run)的比对/测量撞在一起,就是"只画得出第一个字、后面
   * 留着高度没有字"那个毛病(见 CLAUDE.md 坑 27)。注册过的单份样式是稳定引用,
   * 走的是快路径 —— 和所有普通气泡一致。
   *
   * 颜色取命令名那一档:万一内层 span 没画出来,整条至少还是"这是一条命令"的颜色,
   * 不至于变成一段看不出身份的正文(降级也是往好的方向降)。
   */
  userCmdText: { ...USER_TEXT, color: theme.color.userCmd },
  /**
   * 分色那两层。**只写颜色这一个差量**,其余继承外层 —— 两处都是注册过的单份样式。
   *
   * ⚠️ 千万别改成 `style={[styles.userCmdArg, {…}]}` 或就地写对象:那正是这个组件
   * 翻过三次车的那个变量(见 `userCmdText`)。要调这里,只改颜色常量。
   */
  userCmdName: { color: theme.color.userCmd },
  userCmdArg: { color: theme.color.userCmdArg },
  msgImage: { marginBottom: theme.space(2), minWidth: 200 },
  userImage: { marginVertical: theme.space(1), width: 120 },
  imagesRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(2), marginTop: theme.space(2) },
  file: { flexDirection: "row", alignItems: "center", gap: theme.space(2), paddingVertical: theme.space(2), maxWidth: 260 },
  fileName: { flexShrink: 1, color: theme.color.text, fontSize: theme.font.size.sm },
  imageFallback: { color: theme.color.textFaint, fontSize: theme.font.size.sm },

  /** 在大框里:只留块与块之间的气口,外边距和气泡底都由大框统一给 */
  bareWrap: { gap: theme.space(2) },

  /** 系统条(压缩摘要):整宽、不套气泡,和上下两种气泡都区分得开 */
  systemWrap: { paddingHorizontal: theme.space(3), marginBottom: theme.space(3) },
  compactBox: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceAlt,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    gap: theme.space(2),
  },
  compactHead: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  compactTitle: { color: theme.color.textDim, fontSize: theme.font.size.xs, flex: 1 },
  compactMeta: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  compactBody: {
    color: theme.color.textDim,
    fontSize: theme.font.size.sm,
    lineHeight: 20,
  },
});
