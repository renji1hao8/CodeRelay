import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Linking,
  PanResponder,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type TextStyle,
} from "react-native";
import { theme } from "../theme";
import { ZoomableImage } from "../components/ZoomableImage";
import type { Align, BlockNode, InlineNode, TableRow } from "./build";
import { imageUri } from "./resolver";
import { CodeBlock } from "./CodeBlock";

/**
 * 节点树 → React Native 组件树。
 *
 * 样式全部走 theme.ts。这里刻意不套用现成的 markdown 组件库:它们都自带一套
 * 样式系统(CSS-in-JS 或 style 对象约定),和这套按 token 取值的视觉体系对不上,
 * 混用只会让"改外观要去哪改"变得不确定。
 */

const { md: mdTheme } = theme;

/* ------------------------------------------------------------- 行内渲染 -- */

/** 取出纯文本,用来估算表格列宽 */
function plainText(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case "text":
          return n.text;
        case "code":
          return n.text;
        case "image":
          return n.alt;
        case "break":
          return " ";
        default:
          return plainText(n.children);
      }
    })
    .join("");
}

function renderInline(nodes: InlineNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.kind) {
      case "text":
        return node.text;
      case "break":
        return "\n";
      case "code":
        return (
          <Text key={key} style={styles.inlineCode}>
            {node.text}
          </Text>
        );
      case "strong":
        return (
          <Text key={key} style={styles.bold}>
            {renderInline(node.children, key)}
          </Text>
        );
      case "em":
        return (
          <Text key={key} style={styles.italic}>
            {renderInline(node.children, key)}
          </Text>
        );
      case "strike":
        return (
          <Text key={key} style={styles.strike}>
            {renderInline(node.children, key)}
          </Text>
        );
      case "link":
        return (
          <Text key={key} style={styles.link} onPress={() => openUrl(node.href)}>
            {renderInline(node.children, key)}
          </Text>
        );
      case "image":
        // 图片是块级的,由上层切开渲染(见 renderBlocks 里的切分)。
        // 真嵌在加粗/链接里的极少数情况,这里退化成 alt 文字,至少不丢信息。
        return node.alt ? (
          <Text key={key} style={styles.link} onPress={() => openUrl(node.src)}>
            {node.alt}
          </Text>
        ) : null;
      default:
        return null;
    }
  });
}

/** 打不开就算了 —— 链接点不出去不该把整条消息搞崩 */
function openUrl(url: string): void {
  void Linking.openURL(url).catch(() => {});
}

/** 段落里可能混着图片。图片不能塞进 <Text>,所以按它切开 */
function splitByImage(nodes: InlineNode[]): Array<{ kind: "text"; nodes: InlineNode[] } | { kind: "image"; node: InlineNode & { kind: "image" } }> {
  const out: Array<{ kind: "text"; nodes: InlineNode[] } | { kind: "image"; node: InlineNode & { kind: "image" } }> = [];
  let buf: InlineNode[] = [];
  for (const n of nodes) {
    if (n.kind === "image") {
      if (buf.length > 0) out.push({ kind: "text", nodes: buf });
      buf = [];
      out.push({ kind: "image", node: n });
    } else {
      buf.push(n);
    }
  }
  if (buf.length > 0) out.push({ kind: "text", nodes: buf });
  return out;
}

function ParagraphBody({ nodes, style }: { nodes: InlineNode[]; style: TextStyle }) {
  const parts = splitByImage(nodes);
  return (
    <>
      {parts.map((part, i) =>
        part.kind === "image" ? (
          <InlineImage key={i} node={part.node} />
        ) : (
          <Text key={i} style={style} selectable>
            {renderInline(part.nodes, `p${i}`)}
          </Text>
        ),
      )}
    </>
  );
}

function InlineImage({ node }: { node: { src: string; alt: string } }) {
  const uri = imageUri(node.src);
  // 解析不出来(没有 resolver、或者是相对路径)就退化成一行文字,
  // 让人至少知道这儿本来有张图、它指向哪
  if (!uri) {
    return <Text style={styles.imageFallback}>[图片] {node.alt || node.src}</Text>;
  }
  return (
    <View style={styles.imageWrap}>
      <ZoomableImage uri={uri} caption={node.alt || undefined} />
    </View>
  );
}

/* ------------------------------------------------------------- 表格渲染 -- */

/**
 * 单元格文字的近似宽度。mono/中英混排下这是个够用的估算,不是精确排版。
 *
 * ⚠️ **必须区分拉丁与中日韩。** 原来一律按 `字符数 × 7.2` 算,而 7.2 是**拉丁字母**
 * 的宽度 —— 中文一个字差不多是它的两倍。后果是中文表格被严重低估:列宽按"字符数"
 * 摊下来,中文列分到的份额远小于实际需要,文字被挤得频繁折行。
 *
 * 这个值是照着实测倒推的:真机 dump 视图层级,13dp 字号在 3x 屏上一个汉字约 39px,
 * 即 13dp/字 —— 取 13.6 留一点余量。拉丁按 7.2。
 */
const CHAR_W = 7.2;
const CHAR_W_WIDE = 13.6;

/** 是不是"双宽"字符:中日韩表意文字、假名、谚文、全角标点 */
function isWideChar(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) || // 谚文字母
    (c >= 0x2e80 && c <= 0xa4cf) || // CJK 部首 / 假名 / 表意文字
    (c >= 0xac00 && c <= 0xd7a3) || // 谚文音节
    (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容表意
    (c >= 0xfe30 && c <= 0xfe6f) || // CJK 兼容形式
    (c >= 0xff00 && c <= 0xff60) || // 全角 ASCII
    (c >= 0xffe0 && c <= 0xffe6)
  );
}

function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += isWideChar(c) ? CHAR_W_WIDE : CHAR_W;
  }
  return w;
}

const COL_MIN = 76;
const COL_MAX = 300;

function MdTable({ node, tail }: { node: Extract<BlockNode, { kind: "table" }>; tail: boolean }) {
  const [boxW, setBoxW] = useState(0);

  // 表头与表体在 markdown-it 里是两段结构,渲染时接成一串
  const allRows: TableRow[] = [...node.head, ...node.rows];
  const cols = Math.max(node.align.length, ...allRows.map((r) => r.length), 0);

  // 按每列最长内容估宽 —— 注意是**按像素宽**估,不是按字符数(中文是双宽,见 textWidth)。
  // 旧实现的毛病是所有列都 flex:1,于是"长内容"和"x"一样宽,表格既看不出层次、
  // 又会被挤成一条条竖线。
  const natural: number[] = [];
  for (let c = 0; c < cols; c++) {
    let widest = 0;
    for (const row of allRows) {
      const w = textWidth(plainText(row[c] ?? []));
      if (w > widest) widest = w;
    }
    natural.push(Math.min(Math.max(widest + mdTheme.cellPad * 2, COL_MIN), COL_MAX));
  }

  const naturalTotal = natural.reduce((a, b) => a + b, 0);
  // 比可用宽度窄 → 摊开撑满(免得缩在左边);比可用宽度宽 → **保持自然列宽**,
  // 多出来的部分靠横向拖动看。这是这张表最初的设计意图,保留。
  const scale = boxW > 0 && naturalTotal < boxW ? boxW / naturalTotal : 1;
  const widths = natural.map((w) => Math.round(w * scale));
  const contentW = widths.reduce((a, b) => a + b, 0);
  const maxScroll = Math.max(0, contentW - boxW);

  const onLayout = (e: LayoutChangeEvent) => setBoxW(e.nativeEvent.layout.width);

  const shiftX = useRef(new Animated.Value(0)).current;
  /** 已偏移的量(正值),与 shiftX 的负值互为相反数 */
  const scrolled = useRef(0);
  const maxScrollRef = useRef(0);
  maxScrollRef.current = maxScroll;

  /**
   * 横向拖动由我们自己接管,**不用横向 ScrollView**。
   *
   * 为什么:横向 ScrollView 嵌在竖向消息列表里时,Android 靠"谁先越过 touch slop"
   * 决定手势归属 —— 而手指横拖几乎必然带一点上下抖动,父列表的纵向 slop 又很小,
   * 于是横向拖动经常被列表抢走(使用者原话:「总是被上下滑动给顶掉」)。
   * RN 的横向 ScrollView 要等自己检测出横向拖动才去 requestDisallowInterceptTouchEvent,
   * 那时候父列表往往已经赢了 —— 这是平台层面的抢法,调参救不回来。
   *
   * 改法:只有**横向位移明显大于纵向**时才接管手势,其余一律放行,上下翻列表毫不受影响。
   * 而且 JS responder 一旦被接管,RN 会通知原生父 ScrollView 中止本次滚动
   * (onChildStartedNativeGesture),两者从此不再竞争。
   */
  /** 横向明显占优才算"要平移表格";竖直为主的一律放行,交给外层列表 */
  const shouldPan = (g: { dx: number; dy: number }) =>
    maxScrollRef.current > 0 && Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5;

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => shouldPan(g),
        onMoveShouldSetPanResponderCapture: (_e, g) => shouldPan(g),
        /**
         * ⚠️ **手指按下就接管**(capture 阶段,所以抢得过外面那层长按复制的 Pressable)。
         *
         * 为什么不能在 move 阶段抢:实测确认过 —— 冒泡和 capture 两种 move 判定都试了,
         * 在"外层 Pressable 在按下时就已经是 responder"的情况下,我的回调**根本不会被调用**,
         * 横向拖动逐像素没有任何变化(两张截图残差 0.000)。按下就接管是唯一可靠的时机。
         *
         * 代价本来很大:表格区域内的按下都归我,上下翻列表就废了。所以配合下面那条
         * `onShouldBlockNativeResponder: false` —— 我拿 JS responder,但**不阻断原生响应者**,
         * 于是外层列表照样能竖滚。横向由我平移,两者互不干扰。
         */
        onStartShouldSetPanResponderCapture: () => maxScrollRef.current > 0,
        onShouldBlockNativeResponder: () => false,
        onPanResponderTerminate: () => {
          Animated.spring(shiftX, {
            toValue: -scrolled.current,
            useNativeDriver: true,
            bounciness: 0,
            speed: 20,
          }).start();
        },
        // 已经接管了就别中途让出去(否则拖到一半被列表抢走,更难受)
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_e, g) => {
          // ⚠️ 是**减** g.dx,不是加。`scrolled` 表示"向右滚了多少",
          // 内容要跟着手指走:手指往左(dx 为负)时 scrolled 应该增大。
          // 写成加号会让拖动方向整个反过来(实测:往左拖,表格往右跑)。
          const next = Math.min(Math.max(scrolled.current - g.dx, 0), maxScrollRef.current);
          shiftX.setValue(-next);
        },
        onPanResponderRelease: (_e, g) => {
          // 带一点惯性,手感接近原生。g.vx 是"每毫秒的位移",符号与 dx 同向,
          // 所以同样要取负 —— 手指往左甩(vx 为负)时内容继续往左。
          const raw = scrolled.current - g.dx - g.vx * 160;
          const next = Math.min(Math.max(raw, 0), maxScrollRef.current);
          scrolled.current = next;
          Animated.spring(shiftX, {
            toValue: -next,
            useNativeDriver: true,
            bounciness: 0,
            speed: 20,
          }).start();
        },
      }),
    [shiftX],
  );

  return (
    <View onLayout={onLayout} style={tail ? undefined : styles.blockGap}>
      {/* 表格外框:固定不动,负责边框与裁剪。里面那层才是被横拖的内容 ——
          用 transform 平移,不触发重排,也就不会因为拖动而闪烁。

          这里**故意不用横向 ScrollView**:它和竖向消息列表的手势仲裁在 Android 上
          是不确定的(谁先越过 touch slop 谁赢),横拖经常被列表抢走。
          手势逻辑见上面 PanResponder 的说明。 */}
      <View
        style={[styles.tableFrame, { alignSelf: "stretch" }, boxW > 0 ? { width: boxW } : null]}
        {...pan.panHandlers}
      >
        <Animated.View style={{ width: contentW, transform: [{ translateX: shiftX }] }}>
          {allRows.map((row, ri) => {
            const isHead = ri === 0;
            return (
              <View
                key={ri}
                style={[
                  styles.tr,
                  isHead && styles.trHead,
                  ri === allRows.length - 1 && styles.trLast,
                ]}
              >
                {Array.from({ length: cols }, (_, ci) => {
                  const cell = row[ci] ?? [];
                  const align: Align = node.align[ci] ?? "left";
                  return (
                    <Text
                      key={ci}
                      style={[
                        styles.td,
                        { width: widths[ci] },
                        isHead && styles.tdHead,
                        { textAlign: align },
                      ]}
                    >
                      {renderInline(cell, `t${ri}-${ci}`)}
                    </Text>
                  );
                })}
              </View>
            );
          })}
        </Animated.View>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------- 块级渲染 -- */

function ListBody({ node, tail }: { node: Extract<BlockNode, { kind: "list" }>; tail: boolean }) {
  return (
    <View style={tail ? undefined : styles.blockGap}>
      {node.items.map((item, i) => (
        <View key={i} style={styles.listRow}>
          {/* 符号那一栏固定宽度,让所有项的左边缘对齐 */}
          <View style={styles.bulletCol}>
            {item.task === null ? (
              // 用实心大点 `•`。原来是 `·`(U+00B7,间隔号)—— 它既窄又淡,
              // 真机上几乎看不出是个列表符号
              <Text style={styles.bullet}>{node.ordered ? `${(node.start || 1) + i}.` : "•"}</Text>
            ) : (
              <Text style={[styles.check, item.task && styles.checkOn]}>
                {item.task ? "☑" : "☐"}
              </Text>
            )}
          </View>
          <View style={styles.listBody}>
            {renderBlocks(item.children, true)}
          </View>
        </View>
      ))}
    </View>
  );
}

function renderBlock(node: BlockNode, key: string, tail: boolean): ReactNode {
  switch (node.kind) {
    case "heading": {
      const level = Math.min(Math.max(node.level, 1), 3);
      const gap = level === 1 ? mdTheme.headingGap.h1 : level === 2 ? mdTheme.headingGap.h2 : mdTheme.headingGap.h3;
      const size = level === 1 ? theme.font.size.xl : level === 2 ? theme.font.size.lg : theme.font.size.md;
      return (
        <Text
          key={key}
          style={[styles.heading, { fontSize: size, marginBottom: tail ? 0 : gap }]}
        >
          {renderInline(node.inline, key)}
        </Text>
      );
    }

    case "paragraph":
      return (
        <View key={key} style={tail || node.tight ? undefined : styles.blockGap}>
          <ParagraphBody nodes={node.inline} style={styles.body} />
        </View>
      );

    case "code":
      return (
        <View key={key} style={tail ? undefined : styles.blockGap}>
          <CodeBlock code={node.text} lang={node.lang} label={node.label} />
        </View>
      );

    case "list":
      return <ListBody key={key} node={node} tail={tail} />;

    case "quote":
      return (
        <View key={key} style={[styles.quote, tail ? undefined : styles.quoteGap]}>
          {renderBlocks(node.children, true)}
        </View>
      );

    case "table":
      return <MdTable key={key} node={node} tail={tail} />;

    case "hr":
      return <View key={key} style={[styles.hr, tail && styles.hrTail]} />;

    default:
      return null;
  }
}

/**
 * `nested` 表示这是列表项/引用块内部的内容:此时段距要收紧,
 * 否则一个两条的列表会占掉大半屏。
 */
export function renderBlocks(nodes: BlockNode[], nested = false): ReactNode[] {
  const last = nodes.length - 1;
  return nodes.map((node, i) => {
    const tail = i === last;
    const rendered = renderBlock(node, `b${i}`, tail);
    if (!nested || node.kind === "list") return rendered;
    // 嵌套场景下用更紧的间距包一层
    return (
      <View key={`w${i}`} style={tail ? undefined : styles.nestedGap}>
        {rendered}
      </View>
    );
  });
}

const styles = StyleSheet.create({
  body: {
    color: theme.color.text,
    fontSize: theme.font.size.md,
    lineHeight: mdTheme.lineHeight,
  },
  /** 块与块之间。整段消息的最后一个块不给,免得气泡底部拖一截空白 */
  blockGap: { marginBottom: mdTheme.paraGap },
  nestedGap: { marginBottom: mdTheme.quoteGap },
  bold: { fontWeight: theme.font.weight.bold },
  italic: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through", color: theme.color.textDim },
  link: { color: theme.color.accent, textDecorationLine: "underline" },
  /**
   * 行内代码只保留等宽 + 前景色,不给背景。
   * RN 里 Text 的背景会撑满整行行高,在浅色气泡上就是一块突兀的深色补丁 ——
   * 而 AI 回复里反引号极密集,满屏补丁。等宽本身已经足够区分了。
   */
  inlineCode: {
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm,
    color: theme.color.inlineCode,
  },
  heading: { color: theme.color.text, fontWeight: theme.font.weight.bold },

  listRow: { flexDirection: "row", marginBottom: mdTheme.listGap },
  // 符号那一栏:宽度固定(有序列表的 "12." 要放得下),但符号**居中**。
  // 原来左对齐 —— 而 `·` 只占几个像素,于是符号右边空出一大截:
  // 「点离文字太远」,而且左右留白不对称。居中之后两侧等距,视觉上就正了。
  bulletCol: { width: mdTheme.bulletCol, alignItems: "center" },
  bullet: { color: theme.color.textDim, fontSize: theme.font.size.md, lineHeight: mdTheme.lineHeight },
  check: { color: theme.color.textFaint, fontSize: theme.font.size.md, lineHeight: mdTheme.lineHeight },
  checkOn: { color: theme.color.ok },
  listBody: { flex: 1 },

  quote: {
    borderLeftWidth: mdTheme.quoteBar,
    borderLeftColor: theme.color.border,
    paddingLeft: theme.space(3),
  },
  quoteGap: { marginBottom: mdTheme.paraGap },

  hr: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.color.borderStrong,
    marginBottom: mdTheme.paraGap,
  },
  hrTail: { marginBottom: 0 },

  imageWrap: { marginBottom: theme.space(2) },
  imageFallback: { color: theme.color.textFaint, fontSize: theme.font.size.sm },

  /** 表格外框:固定不动,负责边框与裁剪。被横拖的内容在它里面平移 */
  tableFrame: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    // 裁掉平移到外面的部分 —— 没有它,拖动时内容会盖到旁边的布局上
    overflow: "hidden",
  },
  tr: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  trHead: { backgroundColor: theme.color.surfaceAlt },
  trLast: { borderBottomWidth: 0 },
  td: {
    paddingHorizontal: mdTheme.cellPad,
    paddingVertical: mdTheme.cellPad,
    color: theme.color.text,
    fontSize: theme.font.size.sm,
    lineHeight: 20,
  },
  tdHead: { color: theme.color.textDim, fontWeight: theme.font.weight.bold },
});
