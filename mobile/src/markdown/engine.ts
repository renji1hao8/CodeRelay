import MarkdownIt, { type Token } from "markdown-it";
import cjkFriendly from "markdown-it-cjk-friendly";
import { Prism } from "prism-react-renderer";
import PrismJS from "prismjs";

/**
 * 解析引擎。
 *
 * 用 markdown-it 换掉了原先那套自己写的逐行扫描器。换它的理由不是"懒得写",
 * 而是原实现在结构上覆盖不了 CC 真实输出里的常见形状 —— 嵌套列表、任务列表、
 * 链接、表格列对齐、行内代码里嵌 `**` 等等,全都是手工 scanner 的边角洞。
 * markdown-it 是 CommonMark 的参考级实现,这些白拿,且它纯 JS、零原生依赖。
 *
 * 渲染仍然是自己的(见 render.tsx):样式必须完全走 theme.ts,套用现成组件的
 * 样式系统会和这套视觉体系打架。
 */

// prism-react-renderer 自带的那套语法里没有 bash / java / diff / docker / toml / ini,
// 而这几样恰好是 CC 输出里最高频的(命令行、改动对比、容器配置)。
// prismjs 的语言组件是自注册式的:它们往"自己那个 Prism 实例"上挂语法,
// 所以 import 完之后得把语法搬一次到 prism-react-renderer 的实例上。
// 显式带上 .js:prismjs 没有 exports 字段,深路径导入到处都能用,但省略扩展名
// 只有打包器认,裸 node 跑测试时不认。
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-java.js";
import "prismjs/components/prism-diff.js";
import "prismjs/components/prism-docker.js";
import "prismjs/components/prism-toml.js";
import "prismjs/components/prism-ini.js";

const EXTRA_LANGS = ["bash", "java", "diff", "docker", "toml", "ini"] as const;

const prismLangs = Prism.languages as Record<string, unknown>;
for (const lang of EXTRA_LANGS) {
  const grammar = (PrismJS.languages as Record<string, unknown>)[lang];
  // 不覆盖已有的:prism-react-renderer 自带的版本可能更完整
  if (grammar && !prismLangs[lang]) prismLangs[lang] = grammar;
}

export { Prism };

/** 围栏上写的各种简写 → Prism 认识的名字 */
const LANG_ALIAS: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  py: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  "sh-session": "bash",
  yml: "yaml",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  golang: "go",
  md: "markdown",
  htm: "markup",
  html: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  cxx: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  cc: "cpp",
  hh: "cpp",
  cs: "csharp",
  "c#": "csharp",
  rb: "ruby",
  dockerfile: "docker",
  // 这些是"明确不要高亮"的意思。归到空串,走纯文本分支
  text: "",
  txt: "",
  plain: "",
  plaintext: "",
  log: "",
};

/**
 * 把代码围栏上的语言名归一到 Prism 认识的名字。
 *
 * 认不出来就返回空串 —— 按纯文本渲染。这比瞎猜一套语法好:猜错会把普通标识符
 * 染成花的,比不高亮还难读。
 */
export function resolveLang(info: string): string {
  // ```ts title="a.ts" 这种附加属性要去掉,只留语言名
  const raw = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!raw) return "";
  const name = LANG_ALIAS[raw] ?? raw;
  return name && prismLangs[name] ? name : "";
}

// 不标注返回类型:默认导入的 `MarkdownIt` 绑到的是那个**值**,
// 它同时遮蔽了 markdown-it 导出的同名类型,标上去会报"把值当类型用"。
export const md = new MarkdownIt({
  /**
   * 不解析 HTML。CC 偶尔会甩一段 <div> 之类的字面文本出来,渲染成原生视图既没必要,
   * 也会把聊天气泡的布局搞乱;按文本原样显示反而更贴合"它在给你看一段代码"。
   */
  html: false,
  /** 裸 URL 自动变链接 —— CC 经常直接把地址甩出来 */
  linkify: true,
  /**
   * 不做 smartquotes 之类的排版替换。输出的中文引号本来就是对的,
   * 替换反而会把它弄坏。
   */
  typographer: false,
  /**
   * 单个换行不当 <br>。中文写作里换行常常只是折行而非断句,
   * 变 <br> 会把一段话切得七零八落。
   */
  breaks: false,
});
md.use(cjkFriendly);

/**
 * 表格与删除线在 markdown-it 的 default preset 里本来就开着,不用额外配置;
 * 任务列表不在核心里,但它不需要插件也能做 —— 见 build.ts 的 extractTasks。
 */

export type { Token };
