import { useMemo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { buildTree } from "./build";
import { renderBlocks } from "./render";

/**
 * Markdown 渲染。解析用 markdown-it(CommonMark 参考实现),
 * 渲染是自己写的 —— 样式必须完全走 theme.ts,套现成组件的样式系统会和这套
 * 视觉体系打架。详见 engine.ts 与 render.tsx 顶部的说明。
 */
export function Markdown({ text, style }: { text: string; style?: StyleProp<ViewStyle> }) {
  // 流式输出时 text 每帧都在变,这个 memo 命中率不高;但它至少挡住了
  // "父组件因为别的原因重渲染"那条路径 —— 旧实现每次渲染都会重新扫一遍全文。
  const nodes = useMemo(() => buildTree(text), [text]);
  return <View style={style}>{renderBlocks(nodes)}</View>;
}

export { setFileUrlResolver } from "./resolver";
