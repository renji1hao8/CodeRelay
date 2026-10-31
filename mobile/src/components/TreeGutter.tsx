import { StyleSheet, View } from "react-native";
import { INDENT, TREE_LINE_OFFSET } from "../sessionTree";
import { theme } from "../theme";

/**
 * 会话列表左侧那道**树状竖线**。
 *
 * 光有缩进不够:两个同级目录各自缩进之后,还是看不出哪些会话挂在哪个目录下。
 * 画一条贯穿的竖线,子级才真正"连"在父级上。线是每一行各画自己那一段拼出来的 ——
 * 行与行本来就相邻,拼起来是连续的。
 *
 * ⚠️ 它原来长在 `screens/SessionsScreen.tsx` 里,是**因为那个样式表是模块私有的**
 * 才一起搬出来的(留在原地就得循环依赖)。Claude 与 Codex 两个列表共用这一份。
 * 位置算式在 `sessionTree.ts::indentOf` 那一族里,别在这儿另算一套。
 */
export function TreeGutter({ depth }: { depth: number }) {
  if (depth === 0) return null;
  const left = theme.gutter + (depth - 1) * INDENT + TREE_LINE_OFFSET;
  return <View style={[styles.treeLine, { left }]} pointerEvents="none" />;
}

const styles = StyleSheet.create({
  /**
   * 只有一根竖线。
   *
   * ⚠️ 会话行原来还各画一小段横线(`├─` 那种 tick),2026-09-20 使用者要求删掉 ——
   * 行间已经有分割线了,再来一段横的会打架,只留竖线最干净。
   */
  treeLine: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: theme.color.border,
  },
});
