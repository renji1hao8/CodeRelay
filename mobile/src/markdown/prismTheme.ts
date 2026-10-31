import type { PrismTheme } from "prism-react-renderer";
import { theme } from "../theme";

const { syn } = theme.color;

/**
 * 暖色语法高亮主题。
 *
 * prism-react-renderer 自带的那些(vsDark、GitHub、Dracula…)全是冷色深底,
 * 铺在这套暖棕背景上会像贴上去的 —— 这个项目之前就是因为留了一处冷蓝
 * (`#cfe3ff`)而被指出来过。所以这里自己写一份:每种 token 映射到主题已有的
 * 那批色相上,和工具类别配色共用同一套颜色语言,于是"紫色 = 命令/关键字"
 * 这种直觉在两个地方都成立。
 *
 * 规则:一条 types 只挂一种配色,后面的规则会覆盖前面的 —— 所以基础类型
 * (token、punctuation)放最前面,越具体的越靠后。
 */
export const warmPrismTheme: PrismTheme = {
  plain: {
    color: syn.plain,
    // 代码块底色由外层容器给(半透明叠层),这里必须是透明的,
    // 否则会在气泡里挖出一块写死的黑
    backgroundColor: "transparent",
  },
  styles: [
    // 注释压到最暗 —— 它是唯一可以整块忽略的部分
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: { color: syn.comment, fontStyle: "italic" },
    },
    { types: ["punctuation"], style: { color: syn.punct } },
    { types: ["operator", "entity", "url", "namespace"], style: { color: syn.punct } },

    { types: ["keyword", "atrule", "rule", "important"], style: { color: syn.keyword } },
    { types: ["control", "directive", "directive-hash"], style: { color: syn.keyword } },

    { types: ["string", "char", "attr-value", "inserted"], style: { color: syn.string } },
    { types: ["number", "boolean", "constant", "symbol"], style: { color: syn.number } },
    { types: ["builtin"], style: { color: syn.type } },
    { types: ["class-name", "maybe-class-name"], style: { color: syn.type } },

    { types: ["function", "method", "function-variable"], style: { color: syn.func } },
    { types: ["property", "attr-name", "selector", "key"], style: { color: syn.prop } },
    { types: ["parameter", "variable"], style: { color: syn.plain } },

    { types: ["tag", "deleted", "doctype-tag"], style: { color: syn.tag } },
    { types: ["regex", "char-class", "regex-source"], style: { color: syn.regex } },

    // diff 专用:增/删整行。背景由 ArtifactCard 那种"改动视图"自己给,
    // 这里只管形状内的文字色。
    { types: ["inserted-sign", "diff-added"], style: { color: syn.string } },
    { types: ["deleted-sign", "diff-removed"], style: { color: syn.tag } },
    { types: ["diff-range"], style: { color: syn.comment } },

    { types: ["bold"], style: { fontWeight: "bold" } },
    { types: ["italic"], style: { fontStyle: "italic" } },
  ],
};
