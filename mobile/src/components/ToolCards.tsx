import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { StoredImage } from "../shared";
import { imageUri } from "../markdown/resolver";
import { nestedShellOf } from "../toolIntent";
import { theme, toolKindOf, toolLabelOf } from "../theme";
import { toolIntent } from "../toolIntent";
import { ZoomableImage } from "./ZoomableImage";

/**
 * 等宽正文的行高 —— **行框必须比字高出一截,否则字会上下各探出去几像素**。
 *
 * ⚠️ 2026-09-20 定下来的数,别再压回去。这条踩过两次:
 *
 * 第一次把行高从 19 提到 21,并在注释里写"13sp 的 monospace 连字体内边距约占 20.4px,
 * 21 只剩不到 1px" —— 也就是说当时就知道只剩不到 1px,却当成"够了"收工了。
 *
 * 第二次是使用者的原话:「执行结果被遮住一部分,还是老问题 —— 上面几个 px 被遮住,
 * 下面一行几个 px 进来」。那正是余量不够的典型样子:行框(21)比字需要的(≈20.4)只高
 * 0.6px,`includeFontPadding: false` 又把系统额外给的那几 px 拿掉了,于是首行的
 * ascender 被裁掉一点、下一行的顶端从行框下沿挤进来一点。
 *
 * 所以留出**明显**的余量(约 1.8 倍字号)。代价只是几行文字看上去松一点 ——
 * 比"看不全"划算得多。将来再有人觉得"太松了想压一压":那正是这个 bug 复发的方式。
 */
const MONO_LINE_SM = 24;
const MONO_LINE_XS = 21;

export function ToolCard({
  name,
  input,
  dense,
  bare,
  shell,
}: {
  name: string;
  input: unknown;
  /** 组内展示时收紧留白,避免一长条卡片把列表撑得更高 */
  dense?: boolean;
  bare?: boolean;
  /**
   * Bash 工具用的那个 shell(由后端在 init 帧里报,App 不写死)。
   * 只对"执行命令"这一类的工具显示 —— Read/Write 上标个 shell 是纯噪音。
   */
  shell?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // 摘要只要"动的是什么",不要标题 —— 标题已经在上面那行工具名里了
  const { detail: summary, description } = toolIntent(name, input);
  const detail = JSON.stringify(input, null, 2);
  const kind = toolKindOf(name);
  // 命令里显式调了另一个 shell 的话,再叠一个角标(见 nestedShellOf 的说明)
  const nested = kind.kind === "exec" && summary ? nestedShellOf(summary) : null;

  return (
    <View style={[styles.toolCard, dense && styles.toolCardDense, bare && styles.bare]}>
      <View style={styles.toolHeader}>
        <View style={styles.toolNameRow}>
          <Ionicons name={kind.icon} size={12} color={kind.color} />
          <Text style={[styles.toolName, { color: kind.color }]}>{toolLabelOf(name)}</Text>
          {/*
            「执行命令 · Git Bash」—— 答"这次是在哪个 shell 里跑的"。
            ⚠️ 只给 **Bash** 这一个工具标:这个值报的是**Bash 工具用的那个 shell**,
            而 `PowerShell` 是另一个工具(它跑在 pwsh 里),给它挂上"Git Bash"就是错的。
          */}
          {name === "Bash" && shell ? (
            <Text style={styles.toolShell} numberOfLines={1}>
              · {shell}
            </Text>
          ) : null}
          {nested ? (
            <Text style={[styles.toolNested, { color: kind.color }]} numberOfLines={1}>
              嵌套 {nested}
            </Text>
          ) : null}
        </View>
        <Text style={styles.toolToggle} onPress={() => setExpanded((v) => !v)}>
          {expanded ? "收起参数" : "查看参数"}
        </Text>
      </View>
      {description ? <Text style={styles.purpose} numberOfLines={3}>{description}</Text> : null}
      {expanded ? (
        <Text style={styles.toolDetail} selectable>
          {detail}
        </Text>
      ) : summary ? (
        <Text style={styles.toolSummary} numberOfLines={1}>
          {summary}
        </Text>
      ) : null}
    </View>
  );
}

export function ToolResult({
  text,
  isError,
  images,
  dense,
  bare,
}: {
  text: string;
  isError: boolean;
  /**
   * 这次调用产出的图(Read 读到一张图就是它)。
   *
   * ⚠️ 必须画在**这张结果卡里面**。曾经把它当成独立的 image 块塞进消息,结果图脱离了
   * "是哪次调用产生的"这个上下文,还因为消息 role 是 user 而渲染成了使用者自己发的图。
   */
  images?: StoredImage[];
  dense?: boolean;
  bare?: boolean;
}) {
  const hasImages = (images?.length ?? 0) > 0;
  // 默认**折叠**。
  //
  // 曾经是默认展开(理由是"图就是这个结果的主要内容,折起来等于什么都没给")。
  // 但真机上用下来:一个会话里 CC 可能 Read 十几张图,每张都铺满屏幕,
  // 消息列表被撑得根本翻不动。现在折起来 —— 标题那行已经写着「· N 张图」,
  // 想看的人点一下「展开」就看到,不想看的人不必滚过一整屏。
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  // 折叠只留一行 —— 反正有「展开全部」;单行但超长的也算可展开
  const canExpand = lines.length > 1 || text.length > 90;

  return (
    <View style={[styles.resultCard, dense && styles.resultCardDense, bare && styles.resultBare, isError && styles.resultError]}>
      <View style={styles.resultHeader}>
        <Text style={[styles.resultLabel, isError && { color: theme.color.danger }]}>
          {isError ? "执行出错" : "执行结果"}
          {hasImages ? ` · ${images!.length} 张图` : ""}
        </Text>
        {canExpand || hasImages ? (
          <Text style={styles.toolToggle} onPress={() => setExpanded((v) => !v)}>
            {expanded ? "收起" : canExpand ? `展开全部 ${lines.length} 行` : "展开"}
          </Text>
        ) : null}
      </View>

      {/* 文本为空就不画那一行 —— Read 一张图的结果正文就是空的,留个空行只是噪音 */}
      {text.trim() ? (
        <Text
          style={[styles.resultText, isError && { color: theme.color.danger }]}
          numberOfLines={expanded ? undefined : 1}
          selectable
        >
          {text}
        </Text>
      ) : null}

      {hasImages && expanded
        ? images!.map((img, i) => {
            const uri = imageUri(img.path);
            if (!uri) return null;
            return (
              <View key={i} style={styles.resultImage}>
                <ZoomableImage uri={uri} />
              </View>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bare: { backgroundColor: "transparent", borderWidth: 0, marginVertical: 0, paddingHorizontal: 0 },
  resultBare: { borderWidth: 0, marginBottom: 0 },
  toolCard: {
    backgroundColor: theme.color.surfaceAlt,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space(3),
    marginVertical: theme.space(1),
  },
  purpose: { color: theme.color.text, fontSize: theme.font.size.sm, lineHeight: 21, marginTop: theme.space(2) },
  // 组内间距统一交给父级的 gap,自己不再带 margin
  toolCardDense: { padding: theme.space(2) },
  toolHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  toolNameRow: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1 },
  toolName: { fontSize: theme.font.size.sm, fontWeight: "700" },
  /** 工具名后面那个灰的 shell 名(「执行命令 · Git Bash」) */
  toolShell: { color: theme.color.textFaint, fontSize: theme.font.size.xs, flexShrink: 1 },
  /** 「嵌套 pwsh」角标 —— 用工具自己的配色,扫一眼就知道这条命令不在默认 shell 里跑 */
  toolNested: { fontSize: theme.font.size.xs, fontWeight: theme.font.weight.bold },
  toolToggle: { color: theme.color.textFaint, fontSize: theme.font.size.xs, paddingVertical: 2 },
  toolSummary: {
    color: theme.color.text,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm,
    marginTop: theme.space(2),
    lineHeight: MONO_LINE_SM,
    includeFontPadding: false,
  },
  toolDetail: {
    color: theme.color.textDim,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
    marginTop: theme.space(2),
    lineHeight: MONO_LINE_XS,
    includeFontPadding: false,
  },
  resultCard: {
    backgroundColor: theme.color.codeBg,
    borderRadius: theme.radius.md,
    padding: theme.space(3),
    marginBottom: theme.space(2),
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  resultCardDense: { padding: theme.space(2) },
  resultError: { borderColor: theme.color.danger },
  resultHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  resultLabel: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  /** 结果里带的图。minWidth 是为了让 ZoomableImage 量尺寸前也有个可用的下限 */
  resultImage: { marginTop: theme.space(2), minWidth: 200 },
  resultText: {
    color: theme.color.resultText,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm,
    lineHeight: MONO_LINE_SM,
    // 见 MONO_LINE_SM 的说明:这是"执行结果一行被裁掉上半截"的根治办法
    includeFontPadding: false,
  },
});
