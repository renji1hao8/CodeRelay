/**
 * ⚠️ 这一行**带 `.ts` 后缀是故意的**。
 *
 * 这个文件是一条**纯逻辑**,配了裸 Node 用例(`scripts/check-codex-tree.mjs`)——
 * 而裸 Node 的 ESM **不做扩展名补全**,写 `./theme` 会报 ERR_MODULE_NOT_FOUND。
 * `tsconfig` 里 `allowImportingTsExtensions` 是开着的,Metro 也按字面路径解析,
 * 所以带后缀两边都认。别的文件照旧不写后缀 —— 只在这里例外,理由就是"要能被用例直接跑"。
 */
import { theme } from "./theme.ts";

/**
 * 会话列表那套**按目录分组的树** —— 抽出来给两页共用。
 *
 * ## 为什么抽出来
 *
 * 它原来长在 `screens/SessionsScreen.tsx` 里(Claude 那条列表)。Codex 那条列表要
 * **完全一样**的分组(缩进、折叠、计数、竖线导引),而 `mobile/CLAUDE.md` 有一条
 * 硬约定:**两套页面必须长一样,样式数值也是照抄的** —— 所以这里不是"顺手复用",
 * 是那条约定要求它们**只有一份**。
 *
 * ## 为什么是泛型 + 取字段的函数
 *
 * 两个列表的字段名不一样:Claude 是 `SessionSummary.projectPath` / `.title`,
 * Codex 是 `CodexThreadSummary.cwd` / `.name`。硬按其中一个写死,另一边就得先造一层
 * 假对象 —— 而假对象最容易在"少填一个字段"时静默出问题。所以改成**传两个取值函数**。
 *
 * ## ⚠️ 改这里等于同时改两页
 *
 * 缩进算错、折叠判反、计数少算一层 —— 这些在**两页上会一起错**。所以它配了用例
 * (`mobile/scripts/check-codex-tree.mjs`),改之前先跑那个。
 */

/** 会话没有目录时的显示名 */
export const UNKNOWN_DIR = "未知目录";

/** 每深一级缩进多少 */
export const INDENT = 14;
/** 竖线在缩进区里的横向位置 —— 靠左一点,不压到文字 */
export const TREE_LINE_OFFSET = 6;

/**
 * 某一层级对应的**左侧留白**。
 *
 * ⚠️ 缩进、竖线、分割线三处必须用**同一个算式** —— 三个地方各写一遍的结果是
 * "分割线比标题多缩了 4px"这种**看着有点歪、但说不清哪里歪**的毛病。
 */
export function indentOf(depth: number): number {
  return theme.gutter + depth * INDENT + 10;
}

/** 一个目录分组。depth 用来缩进:子目录挂在父目录下面,而不是和它平起平坐 */
export interface DirGroup<T> {
  path: string;
  /** 显示名。根目录显示全路径,子目录只显示相对父目录的尾段(父路径已经在上面一行了) */
  label: string;
  depth: number;
  /** 含子树在内的会话总数 —— 折叠时也要能看出来底下有多少东西 */
  count: number;
  data: T[];
}

/**
 * child 是不是 parent 底下的目录。
 *
 * ⚠️ **只按大小写不敏感比,不做分隔符归一** —— 这是从 `SessionsScreen` 原样搬过来的
 * 行为,别在"抽公共件"的时候顺手改掉。已知的后果:`/e/远程cc/server` 与 `/e/远程cc`
 * 仍然会**配得上**(两边都是斜杠),但 `E:\a\b` 与 `E:/a` 这种**混着写**的配不上,
 * 会被当成两个平级的根。
 *
 * 同一目录可能同时以 Git Bash 路径和 Windows 路径出现，需要统一比较。
 * 要合并它们得**同时**归一分隔符和盘符大小写,而那会让 Claude 那条列的表现跟着变 ——
 * 那是另一件事,不要顺手做。用例里有一条把当前行为钉住了,改之前先看它。
 */
export function isUnder(child: string, parent: string): boolean {
  if (child.length <= parent.length) return false;
  if (child.slice(0, parent.length).toLowerCase() !== parent.toLowerCase()) return false;
  const next = child[parent.length];
  return next === "\\" || next === "/";
}

/**
 * 把会话按工作目录聚成**树**,再按折叠状态压平给 SectionList。
 *
 * 之前是一层平铺,于是 `E:\RemoteCC`、`E:\RemoteCC\server`、`E:\RemoteCC\server\data\logs`
 * 会并排出现三个组,看不出谁属于谁 —— 而这些子目录大多是顺路 cd 进去的,
 * 不是真正的工作区。挂成树之后一眼就能分辨。
 *
 * @param dirOf  取"这条会话属于哪个目录"。返回 null/空 = 归到 `UNKNOWN_DIR`
 * @param timeOf 取"最后活动时间"(ISO 字符串)。用来给同级的目录排序,**不参与分组**
 */
export function buildGroups<T>(
  items: T[],
  dirOf: (item: T) => string | null,
  timeOf: (item: T) => string | null,
  collapsed: Set<string>,
): DirGroup<T>[] {
  const byDir = new Map<string, T[]>();
  for (const s of items) {
    const dir = dirOf(s) || UNKNOWN_DIR;
    const list = byDir.get(dir);
    if (list) list.push(s);
    else byDir.set(dir, [s]);
  }

  const dirs = [...byDir.keys()];
  const newestOf = (dir: string) =>
    (byDir.get(dir) ?? []).reduce((m, s) => {
      const raw = timeOf(s);
      const t = raw ? Date.parse(raw) : NaN;
      return Number.isNaN(t) ? m : Math.max(m, t);
    }, 0);
  const byNewest = (list: string[]) => [...list].sort((a, b) => newestOf(b) - newestOf(a));

  // 每个目录挂到"最长的、同时也是已知目录"的那个祖先上。
  // 只认列表里出现过的目录 —— 否则 E:\ditie\...\demo 会被挂到 E:\ 这种不存在的节点上。
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const d of dirs) {
    let parent: string | null = null;
    for (const other of dirs) {
      if (other !== d && isUnder(d, other) && (parent === null || other.length > parent.length)) {
        parent = other;
      }
    }
    if (parent) {
      const arr = childrenOf.get(parent);
      if (arr) arr.push(d);
      else childrenOf.set(parent, [d]);
    } else {
      roots.push(d);
    }
  }

  const countOf = (dir: string): number =>
    (byDir.get(dir)?.length ?? 0) +
    (childrenOf.get(dir) ?? []).reduce((n, k) => n + countOf(k), 0);

  const out: DirGroup<T>[] = [];
  const visit = (dir: string, depth: number, parentPath: string | null) => {
    const kids = childrenOf.get(dir) ?? [];
    const isCollapsed = collapsed.has(dir);

    out.push({
      path: dir,
      label: parentPath ? dir.slice(parentPath.length + 1) : dir,
      depth,
      count: countOf(dir),
      // 折叠 = 整组塌陷,本级的会话一起收起来。这样点一下就能把整个项目收干净,
      // 也是"折叠"这个词通常的意思
      data: isCollapsed ? [] : (byDir.get(dir) ?? []),
    });

    if (isCollapsed) return;
    for (const k of byNewest(kids)) visit(k, depth + 1, dir);
  };

  for (const r of byNewest(roots)) visit(r, 0, null);
  return out;
}
