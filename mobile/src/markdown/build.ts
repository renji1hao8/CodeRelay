import type { Token } from "markdown-it";
import { md, resolveLang } from "./engine";

/**
 * 把 markdown-it 的扁平 token 流变成一棵渲染友好的树。
 *
 * 中间加这一层,是因为直接对着扁平流写渲染会退化成"靠 level 猜嵌套" —— 那正是
 * 旧实现里最容易出错的地方。树建好之后,渲染就只是对着一棵已知形状的树递归。
 */

export type Align = "left" | "center" | "right";

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "em"; children: InlineNode[] }
  | { kind: "strike"; children: InlineNode[] }
  | { kind: "link"; href: string; children: InlineNode[] }
  | { kind: "image"; src: string; alt: string }
  | { kind: "break" };

export interface ListItem {
  /** null = 普通项;true / false = 待办项及它的勾选态 */
  task: boolean | null;
  children: BlockNode[];
}

/** 一个单元格里的行内内容 */
export type TableCell = InlineNode[];
/** 一行里的若干单元格 */
export type TableRow = TableCell[];

export type BlockNode =
  | { kind: "paragraph"; inline: InlineNode[]; tight: boolean }
  | { kind: "heading"; level: number; inline: InlineNode[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; children: BlockNode[] }
  | { kind: "code"; lang: string; label: string; text: string }
  | { kind: "hr" }
  // 表格的表头通常只有一行,但它和表体在 markdown-it 里是两段结构,
  // 所以这里也按"若干行"建模,免得渲染时还要特判单行
  | { kind: "table"; align: Align[]; head: TableRow[]; rows: TableRow[] };

function attr(token: Token, name: string): string | null {
  const found = token.attrs?.find(([k]) => k === name);
  return found ? String(found[1]) : null;
}

/* ---------------------------------------------------------------- 行内 -- */

function readInline(tokens: Token[] | null): InlineNode[] {
  if (!tokens) return [];
  const root: InlineNode[] = [];

  /**
   * 行内嵌套只有 strong/em/s/link 三种,用栈配对 open/close 就够,
   * 没必要为它建一套完整的树。
   */
  type Frame = { kind: "strong" | "em" | "strike" | "link"; href: string; children: InlineNode[] };
  const stack: Frame[] = [];
  const sink = () => (stack.length > 0 ? stack[stack.length - 1]!.children : root);

  const pushText = (text: string) => {
    if (!text) return;
    const target = sink();
    const last = target[target.length - 1];
    // 合并相邻文本:markdown-it 会把 `a**b**c` 切成三段 text 夹一个 strong,
    // 不合并的话每个片段都是一个独立 Text 子节点。
    if (last && last.kind === "text") last.text += text;
    else target.push({ kind: "text", text });
  };

  const open = (kind: Frame["kind"], href = "") => stack.push({ kind, href, children: [] });
  const close = () => {
    const top = stack.pop();
    if (!top) return;
    const target = sink();
    if (top.kind === "link") target.push({ kind: "link", href: top.href, children: top.children });
    else target.push({ kind: top.kind, children: top.children });
  };

  for (const t of tokens) {
    switch (t.type) {
      case "text":
        pushText(t.content);
        break;
      case "code_inline":
        sink().push({ kind: "code", text: t.content });
        break;
      case "strong_open":
        open("strong");
        break;
      case "em_open":
        open("em");
        break;
      case "s_open":
        open("strike");
        break;
      case "link_open":
        open("link", attr(t, "href") ?? "");
        break;
      case "strong_close":
      case "em_close":
      case "s_close":
      case "link_close":
        close();
        break;
      // 软换行与硬换行在 RN 里都是同一个 "\n" —— 区别在于要不要多空一行,
      // 而聊天气泡里两者视觉上本来就该一致。
      case "softbreak":
      case "hardbreak":
        sink().push({ kind: "break" });
        break;
      case "image": {
        // image token 的 content 是 alt 文本;src 在 attrs 里且是百分号编码的
        sink().push({ kind: "image", src: attr(t, "src") ?? "", alt: t.content });
        break;
      }
      default:
        // 其余行内类型(html_inline、entity 等)在 html:false 下不会冒出来;
        // 真冒出来就跳过,不能让一个意外 token 吃掉整段文字
        break;
    }
  }

  // 未闭合的 open 会把内容困在栈里,兜底把它们放回根上
  while (stack.length > 0) close();
  return root;
}

/* ---------------------------------------------------------- 任务列表标记 -- */

const TASK_MARK = /^\[([ xX])\]\s+/;

/**
 * 认出 GFM 的待办列表标记。
 *
 * markdown-it 核心不含 task list 扩展(那是个插件),但不需要插件也能做:
 * 待办项在 token 流里的样子,就是列表项里第一个 inline 的文本以 "[ ] " 开头。
 * 就地改写成勾选标记 + 剥掉前缀,免得为这一件事再引一个依赖。
 */
function extractTasks(tokens: Token[], state: Map<Token, boolean>): void {
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (!open || open.type !== "list_item_open") continue;

    // 列表项的内容在它之后、level 恰好 +2 的那个 inline 上:
    // list_item_open(lvl) → paragraph_open(lvl+1) → inline(lvl+2)
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (!t) break;
      // level 掉回列表项自己这一层,说明这一项已经翻完了
      if (t.level <= open.level) break;
      if (t.type !== "inline" || t.level !== open.level + 2) continue;

      const first = t.children?.[0];
      // 一步步窄化,别把两个判断揉进一个三元 —— 那样 TS 无法把 "mark 非空"
      // 回推到 "first 一定存在"
      if (!first || first.type !== "text") break;
      const mark = TASK_MARK.exec(first.content);
      if (!mark) break;

      state.set(open, mark[1] !== " ");
      first.content = first.content.slice(mark[0].length);
      // inline 自己的 content 也要同步 —— 它是给纯文本回退用的
      t.content = t.content.replace(TASK_MARK, "");
      break;
    }
  }
}

/* ------------------------------------------------------------- 块级构建 -- */

interface Cursor {
  i: number;
}

/**
 * 读到 `stop` 里的任何一个 token 类型就停下,把它留给调用方消费。
 *
 * 这是整个构建器里最关键的一处:没有它,列表项内部的递归读取会把
 * **文档剩下的全部内容**都当成自己的子节点吃掉。
 */
function readBlocks(
  tks: Token[],
  cur: Cursor,
  tasks: Map<Token, boolean>,
  stop: ReadonlySet<string>,
): BlockNode[] {
  const out: BlockNode[] = [];

  while (cur.i < tks.length) {
    const t = tks[cur.i]!;
    if (stop.has(t.type)) break;

    switch (t.type) {
      case "heading_open": {
        const inline = tks[cur.i + 1];
        cur.i += 3; // open + inline + close
        out.push({
          kind: "heading",
          level: Number(t.tag.slice(1)) || 1,
          inline: readInline(inline?.children ?? null),
        });
        break;
      }

      case "paragraph_open": {
        const inline = tks[cur.i + 1];
        // 紧凑列表里的段落被 markdown-it 标了 hidden —— 它不该带来额外段距
        const tight = t.hidden === true;
        cur.i += 3;
        out.push({ kind: "paragraph", inline: readInline(inline?.children ?? null), tight });
        break;
      }

      case "fence":
      case "code_block": {
        cur.i += 1;
        // info 是围栏上原样写的东西(```ts title="a" 的全文),
        // 取第一个词当标签显示 —— 认不出来的语言也该把名字露出来
        const rawLabel = t.type === "fence" ? (t.info.trim().split(/\s+/)[0] ?? "") : "";
        out.push({
          kind: "code",
          lang: t.type === "fence" ? resolveLang(t.info) : "",
          label: rawLabel,
          // 去掉结尾那一个换行:渲染时每行自带断行,留着会多出一行空白
          text: t.content.replace(/\n$/, ""),
        });
        break;
      }

      case "hr":
        cur.i += 1;
        out.push({ kind: "hr" });
        break;

      case "blockquote_open": {
        cur.i += 1;
        const children = readBlocks(tks, cur, tasks, QUOTE_STOP);
        if (tks[cur.i]?.type === "blockquote_close") cur.i += 1;
        out.push({ kind: "quote", children });
        break;
      }

      case "bullet_list_open":
      case "ordered_list_open": {
        const ordered = t.type === "ordered_list_open";
        const start = ordered ? Number(attr(t, "start") ?? "1") || 1 : 1;
        cur.i += 1;

        const items: ListItem[] = [];
        while (cur.i < tks.length) {
          const item = tks[cur.i]!;
          if (item.type === "bullet_list_close" || item.type === "ordered_list_close") break;
          if (item.type !== "list_item_open") {
            cur.i += 1;
            continue;
          }
          cur.i += 1;
          const children = readBlocks(tks, cur, tasks, ITEM_STOP);
          if (tks[cur.i]?.type === "list_item_close") cur.i += 1;
          items.push({ task: tasks.get(item) ?? null, children });
        }
        if (cur.i < tks.length) cur.i += 1; // 吃掉 *_list_close

        out.push({ kind: "list", ordered, start, items });
        break;
      }

      case "table_open":
        cur.i += 1;
        out.push(readTable(tks, cur));
        break;

      default:
        // 未知 token 一律跳过。宁可少渲染一小块,也不能让整个会话卡住
        cur.i += 1;
        break;
    }
  }

  return out;
}

const QUOTE_STOP: ReadonlySet<string> = new Set(["blockquote_close"]);
const ITEM_STOP: ReadonlySet<string> = new Set(["list_item_close"]);
const TOP_STOP: ReadonlySet<string> = new Set();

function readTable(tks: Token[], cur: Cursor): BlockNode {
  const head: TableRow[] = [];
  const rows: TableRow[] = [];
  const align: Align[] = [];

  let inHead = false;
  let row: TableRow | null = null;
  let cell: TableCell | null = null;

  while (cur.i < tks.length) {
    const t = tks[cur.i]!;
    if (t.type === "table_close") {
      cur.i += 1;
      break;
    }

    switch (t.type) {
      case "thead_open":
        inHead = true;
        cur.i += 1;
        break;
      case "thead_close":
        inHead = false;
        cur.i += 1;
        break;
      case "tbody_open":
      case "tbody_close":
        cur.i += 1;
        break;
      case "tr_open":
        row = [];
        cur.i += 1;
        break;
      case "tr_close":
        // 分开写而不是 (inHead ? head : rows).push(row) —— 后者会让 TS 把两个
        // 数组类型求交集成 InlineNode[] & InlineNode[][],报一个莫名其妙的错
        if (row) {
          if (inHead) head.push(row);
          else rows.push(row);
        }
        row = null;
        cur.i += 1;
        break;
      case "th_open":
      case "td_open": {
        // 列号就是当前行已有的单元格数 —— 用它把对齐方式归到列上
        const col = row ? row.length : 0;
        const style = attr(t, "style") ?? "";
        const found = /text-align:\s*(left|center|right)/.exec(style);
        // 只在某一列真的有对齐声明时才写,免得后出现的默认值把先前的覆盖掉
        if (found && !align[col]) align[col] = found[1] as Align;
        cell = [];
        cur.i += 1;
        break;
      }
      case "th_close":
      case "td_close":
        if (row && cell) row.push(cell);
        cell = null;
        cur.i += 1;
        break;
      case "inline":
        if (cell) cell.push(...readInline(t.children ?? null));
        cur.i += 1;
        break;
      default:
        cur.i += 1;
        break;
    }
  }

  return { kind: "table", align, head, rows };
}

/** 渲染入口:源码 → 节点树 */
export function buildTree(source: string): BlockNode[] {
  const tokens = md.parse(source, {});
  const tasks = new Map<Token, boolean>();
  extractTasks(tokens, tasks);
  return readBlocks(tokens, { i: 0 }, tasks, TOP_STOP);
}
