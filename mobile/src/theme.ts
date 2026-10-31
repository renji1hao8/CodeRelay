/**
 * 视觉系统。改这里的值就能整体换肤,页面里不要再写死颜色。
 *
 * 近黑背景、低饱和强调色、靠表面亮度分层,
 * 尽量少用硬边框(满屏 1px 描边会显得很"糊")。
 */
export const theme = {
  color: {
    /** 中性石墨底色；列表、对话和设置共用表面层级 */
    bg: "#121416",
    /** 卡片/面板底色 */
    surface: "#1b1f23",
    /** 比 surface 再抬一层:弹层、输入框、选中项 */
    surfaceAlt: "#242a30",
    /** 按下态 */
    surfacePress: "#303840",

    /** 分隔线。比 surface 只亮一点点就够 */
    border: "#303840",
    /** 需要明确轮廓时(输入框聚焦等)才用 */
    borderStrong: "#4b5662",

    text: "#eef1f4",
    textDim: "#b0b8c3",
    textFaint: "#818b99",

    accent: "#b9cbdf",
    /** 强调色的低饱和底色,用于选中背景、徽标底 */
    accentSoft: "#283441",
    /** accent 上的文字色 */
    onAccent: "#17212b",

    /**
     * 语义三色。
     *
     * ⚠️ 2026-09-19 调过绿色。原来这三个直接用 Tailwind 的 400 档
     * (#4ade80 / #fbbf24 / #f87171),但**本文件里其他颜色都被刻意调成了暖调**
     * (见下面 syn 那段和 toolKindMeta 的注释:"冷蓝混在暖棕底上很跳")——
     * 只有这三个语义色没跟着走。审批卡上那一片绿是最明显的一处。
     *
     * 现在绿色改用本文件已有的暖绿(#8fce7f,写入类工具和语法里的字符串都是它),
     * 黄/红本来就是暖相、又有别处在用(PairScreen / NotifySection),保持不动。
     */
    ok: "#8fce7f",
    okSoft: "#12291c",
    warn: "#fbbf24",
    warnSoft: "#2b2312",
    danger: "#f87171",
    dangerSoft: "#2e1618",

    /** 你说的那条:偏暖的深褐,和下面的半透明块区分开 */
    userBubble: "#283441",
    /**
     * 斜杠命令**命令名**的颜色(判据见 `MessageBubble` 的 `slashCommandOf`)。
     *
     * 命令名压在这层深褐底上,得用强调色才拎得出来。句中出现斜杠的(路径、除号、
     * URL)**一律不上色**:那些一多,整个气泡就花了。
     *
     * ⚠️ 这里有一段翻过三次车的历史(详见 `MessageBubble` 里那段说明与坑 27):
     * 真机上"斜杠命令只画得出开头那个 `/`"。第一次归罪于"用嵌套 Text 分色"、拆了;
     * 第三次(2026-09-19)查明**拆掉嵌套并没有根治** —— 真正的变量是"样式是数组还是
     * 单份"。所以 2026-09-21 应使用者要求把分色加回来,两条硬规矩跟着走:
     * ① 两层都用**注册过的单份样式**;② 留了开关 `SPLIT_COMMAND_COLORS`。
     */
    userCmd: "#b9cbdf",
    /**
     * 同一条命令里**参数**的颜色:同一个色相压暗一档。
     *
     * 参数要看得见(它常常是文件名、分支名,是这条命令真正在做什么),但不该和命令名
     * 抢注意力 —— 一眼扫过去先认出"这是哪条命令",再看它作用于什么。
     */
    userCmdArg: "#90a3b8",
    /** 它回的那条:半透明,只用来圈出范围,不压内容 */
    assistantBubble: "rgba(255, 255, 255, 0.045)",
    codeBg: "#101214",
    diffAdd: "#10291a",
    diffDel: "#2e1618",
    /** 改动行上的文字色。和 diffAdd/diffDel 是一对,不能只给底色 —— 底色那么暗,
     *  正文色压上去会看不出是增还是删 */
    diffAddText: "#9ff0c0",
    diffDelText: "#ffb0b0",

    /**
     * 代码语义色。原先行内代码写死成 #ffd479(纯黄),而 AI 回复里反引号极密集,
     * 结果满屏都在发亮。统一压低饱和度,并按"正文里的片段 / 成块代码 / 执行结果"分工。
     * 色相跟整体走暖棕,不收冷蓝 —— 之前那套在暖底上像贴上去的。
     */
    inlineCode: "#ecc08a",
    codeText: "#d8c8b0",
    resultText: "#b8ab99",

    /**
     * 语法高亮配色。
     *
     * 刻意不用 Prism 自带的主题 —— vsDark / GitHub 那几套都是冷色深底,铺在暖棕底上
     * 会像贴上去的。这里把每种 token 映射到主题已有的那批暖色相上,和工具类别配色
     * 共用同一套颜色语言,所以"紫色=命令"这种直觉在高亮里也成立。
     */
    syn: {
      /** 注释 —— 压到最暗,它是唯一可以忽略的部分 */
      comment: "#818b99",
      keyword: "#c08cf0",
      string: "#8fce7f",
      number: "#f0a868",
      func: "#b9cbdf",
      type: "#c9b96a",
      prop: "#7fc9b8",
      tag: "#f87171",
      regex: "#ef8fb0",
      punct: "#b8ab99",
      plain: "#d8c8b0",
    },

    /**
     * 工具调用组的底。比普通卡片更轻 —— 一轮下来几十次调用,如果每张都做实心卡片,
     * 整个屏幕就只剩卡片了。折叠起来只占一行。
     */
    toolGroupBg: "transparent",
    toolGroupBgPress: "rgba(255, 255, 255, 0.085)",

    /**
     * 弹层背后的遮罩。原先三处各写各的(0.6 / 0.6 / 0.55),
     * 同一个语义有好几个值,统一到这里。
     */
    overlay: "rgba(0, 0, 0, 0.6)",
  },

  space: (n: number) => n * 4,

  radius: { xs: 6, sm: 8, md: 12, lg: 16, xl: 22, pill: 999 },

  font: {
    mono: "monospace" as const,
    size: { xs: 11, sm: 13, md: 15, lg: 17, xl: 22, xxl: 28 },
    weight: {
      regular: "400",
      medium: "500",
      semibold: "600",
      bold: "700",
    } as const,
  },

  /**
   * Markdown 排版度量。
   *
   * 抽成 token 而不是留在 markdown 模块的 StyleSheet 里,是为了守住
   * 「改外观只动 theme.ts」—— 这些值原先散在 markdown.tsx 里,想统一调个段距
   * 得先翻到那个文件。**数值沿用原有观感,没有重新设计**。
   */
  md: {
    lineHeight: 24,
    paraGap: 20,
    /** 标题的段距。三档拉开差距,否则 h2/h3 在手机上认不出来 */
    headingGap: { h1: 10, h2: 8, h3: 6 },
    /** 列表项之间。比段距紧得多,否则一屏放不下几条 */
    listGap: 7,
    /** 列表符号那一栏的宽度,有序列表的 "12." 也要放得下 */
    bulletCol: 20,
    /** 嵌套一层列表再缩进多少 */
    indent: 16,
    quoteBar: 3,
    /** 引用块内的段距,比正文紧 */
    quoteGap: 6,
    /** 代码块底色。半透明而不是写死纯色 —— 它会落在深浅两种气泡里 */
    codeBg: "rgba(0, 0, 0, 0.24)",
    codeLineHeight: 19,
    /** 表格单元格内边距 */
    cellPad: 8,
  },

  /** 常用的横向页边距,统一起来免得每页各写一个数 */
  gutter: 16,
} as const;

/**
 * 工具类别配色。原来所有工具名都用 accent 蓝,一长串调用看起来是一样的;
 * 按"这个工具在干什么"分色后,扫一眼就知道刚才那堆调用是读还是写。
 * 整组跟着主题走暖调 —— 冷蓝混在暖棕底上很跳。
 */
const toolKindMeta = {
  /** 读取 */
  read: { color: "#7fc9b8", icon: "document-text-outline" },
  /** 搜索/查找 */
  search: { color: "#c9b96a", icon: "search-outline" },
  /** 写入/修改 —— 会改文件的操作,给最显眼的绿 */
  write: { color: "#8fce7f", icon: "create-outline" },
  /** 执行命令 */
  exec: { color: "#c08cf0", icon: "terminal-outline" },
  /** 联网 */
  net: { color: "#f0a868", icon: "globe-outline" },
  /** 子任务/代理 */
  agent: { color: "#ef8fb0", icon: "git-branch-outline" },
  /** 其它(MCP 工具等) */
  other: { color: "#9c9c9c", icon: "build-outline" },
} as const;

export type ToolKind = keyof typeof toolKindMeta;

const TOOL_KIND_BY_NAME: Record<string, ToolKind> = {
  command: "exec",
  fileChange: "write",
  webSearch: "net",
  TaskCreate: "agent",
  TaskUpdate: "agent",
  TaskList: "agent",
  TaskStop: "agent",
  TaskOutput: "agent",
  Read: "read",
  NotebookRead: "read",
  Glob: "search",
  Grep: "search",
  Write: "write",
  Edit: "write",
  MultiEdit: "write",
  NotebookEdit: "write",
  Bash: "exec",
  /**
   * Claude Code 自带的 PowerShell 工具(和 Bash 并列的那个)。
   *
   * ⚠️ 它在 Windows 上就是 `pwsh`(7.x),而 Bash 工具走的是 Git Bash —— 两个都是
   * "执行命令",所以归同一类配色。**别把 shell 的版本标到这里**:那个值来自后端报的
   * "Bash 工具用的 shell",挂到这张卡上就串了。版本区分只在 Bash 命令**嵌套**调用
   * 另一个 shell 时才有意义(见 toolIntent 的 nestedShellOf)。
   */
  PowerShell: "exec",
  BashOutput: "exec",
  KillShell: "exec",
  WebFetch: "net",
  WebSearch: "net",
  Task: "agent",
  Agent: "agent",
};

/**
 * 工具名 → 类别配色。认不出来的(mcp__xxx、新工具)一律归 other,不会瞎猜。
 * 不写返回类型标注是有意的:标了会把 icon 放宽成 string,喂给 Ionicons 就报类型错。
 */
export function toolKindOf(name: string) {
  const kind: ToolKind = TOOL_KIND_BY_NAME[name] ?? "other";
  const meta = toolKindMeta[kind];
  return { kind, color: meta.color as string, icon: meta.icon };
}

const TOOL_LABEL: Record<string, string> = {
  command: "执行命令",
  fileChange: "修改文件",
  webSearch: "联网搜索",
  PowerShell: "执行命令",
  TaskCreate: "新建任务",
  TaskUpdate: "更新任务",
  TaskList: "查看任务",
  TaskStop: "停止任务",
  TaskOutput: "查看任务输出",
  Bash: "执行命令",
  Read: "读取文件",
  Write: "写入文件",
  Edit: "修改文件",
  MultiEdit: "批量修改",
  NotebookEdit: "改笔记本",
  Glob: "查找文件",
  Grep: "搜索内容",
  WebFetch: "抓取网页",
  WebSearch: "联网搜索",
  Task: "执行子任务",
  Agent: "执行子任务",
  TodoWrite: "更新计划",
};

/** 工具名 → 中文说法。MCP 工具认不出来就用原名,那个名字本身有信息量 */
export function toolLabelOf(name: string): string {
  return TOOL_LABEL[name] ?? name;
}

/**
 * 工具**类别** → 折叠组标题上的短标签。
 *
 * 和上面 TOOL_LABEL 不是一回事,别合并:那个标的是**单次调用**
 * (Bash → "执行命令"),这个标的是一组调用(exec → "命令 ×12")。
 * 后者要短 —— 一行里还要放下次数。
 */
const TOOL_KIND_LABEL: Record<ToolKind, string> = {
  read: "读取",
  search: "搜索",
  write: "改动",
  exec: "命令",
  net: "联网",
  agent: "子任务",
  other: "工具",
};

export function toolKindLabel(kind: ToolKind): string {
  return TOOL_KIND_LABEL[kind];
}

export const kindMeta: Record<string, { label: string; color: string; icon: string }> = {
  image: { label: "图片", color: "#c58cff", icon: "image-outline" },
  markdown: { label: "文档", color: "#d4b06a", icon: "document-text-outline" },
  report: { label: "报告", color: "#fbbf24", icon: "clipboard-outline" },
  code: { label: "代码", color: "#8fce7f", icon: "code-slash-outline" },
  diff: { label: "改动", color: "#f87171", icon: "git-compare-outline" },
};

/** 文件类型 → 图标与配色。文件浏览页用 */
const fileKindMeta: Record<string, { icon: string; color: string; label: string }> = {
  dir: { icon: "folder", color: "#b9cbdf", label: "文件夹" },
  image: { icon: "image-outline", color: "#c58cff", label: "图片" },
  video: { icon: "videocam-outline", color: "#ef8fb0", label: "视频" },
  audio: { icon: "musical-notes-outline", color: "#8fce7f", label: "音频" },
  archive: { icon: "cube-outline", color: "#fbbf24", label: "压缩包" },
  doc: { icon: "document-text-outline", color: "#d4b06a", label: "文档" },
  pdf: { icon: "document-outline", color: "#f87171", label: "PDF" },
  sheet: { icon: "grid-outline", color: "#8fce7f", label: "表格" },
  code: { icon: "code-slash-outline", color: "#8fce7f", label: "代码" },
  config: { icon: "settings-outline", color: "#9c9c9c", label: "配置" },
  file: { icon: "document-outline", color: "#9c9c9c", label: "文件" },
};

const EXT_KIND: Record<string, keyof typeof fileKindMeta> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image",
  svg: "image", ico: "image", heic: "image",
  mp4: "video", mkv: "video", mov: "video", avi: "video", webm: "video",
  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio", ogg: "audio",
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive", xz: "archive",
  pdf: "pdf",
  doc: "doc", docx: "doc", txt: "doc", md: "doc", rtf: "doc",
  xls: "sheet", xlsx: "sheet", csv: "sheet", tsv: "sheet",
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code",
  py: "code", rs: "code", go: "code", java: "code", kt: "code", c: "code", h: "code",
  cpp: "code", cc: "code", hpp: "code", cs: "code", rb: "code", php: "code", swift: "code",
  sh: "code", bash: "code", ps1: "code", bat: "code", sql: "code", html: "code", css: "code",
  json: "config", yaml: "config", yml: "config", toml: "config", ini: "config",
  cfg: "config", conf: "config", properties: "config", env: "config",
};

/** 按文件名给出该用哪个图标/配色 */
export function fileKindOf(name: string, isDir: boolean): { icon: string; color: string; label: string } {
  if (isDir) return fileKindMeta.dir!;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return fileKindMeta.file!;
  const ext = name.slice(dot + 1).toLowerCase();
  const kind = EXT_KIND[ext];
  return (kind && fileKindMeta[kind]) || fileKindMeta.file!;
}
