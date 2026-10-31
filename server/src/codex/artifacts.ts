import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ArtifactDetail, ArtifactSummary } from "@remote-cc/shared";
import { artifactIdOf, kindOf } from "../artifact-kind.ts";
import { codexClient } from "./client.ts";
import { readThreadSummary } from "./threads.ts";

/**
 * Codex 的产物 —— **另一条数据来源,不是复用 Claude 那条**。
 *
 * ## 为什么另起一条
 *
 * Claude 那边(`routes/artifacts.ts`)是**扫 jsonl**:历遍 assistant 条目里的
 * `Write/Edit/MultiEdit` 工具调用,算一个 id 写进 `artifacts` 表,配一个 kv 增量游标。
 * 那套的前提是"历史索引进 SQLite 的 `messages` 表"。
 *
 * Codex 的历史**不在那张表里**(见 `codex/threads.ts` 的文件头:Codex 的历史本身
 * 就能按需查询,再索引一份是多余的派生数据)。硬塞进去要么造假的 `messages` 行、
 * 要么让 `collectArtifacts` 每一处都分叉。
 *
 * 所以这一份**现算现给**:产物就在 `fileChange` item 里,翻一遍就出来了。
 *
 * ## `fileChange` item 的真实形状(照真数据写的,不是照 schema)
 *
 * ```
 * { type: "fileChange", id: "exec-…", status: "completed",
 *   changes: [ { path: "E:\\…\\x.py",            // ← 实测是**绝对路径**
 *                kind: { type: "update", move_path: null },   // ← ⚠️ 是**对象**,不是字符串
 *                diff: "@@ -41,5 +41,5 @@\n     75: …\n-    76: …\n+    76: …\n" } ] }
 * ```
 *
 * ⚠️ `kind` 是 `{type, move_path}`,照着 schema 里那个 `PatchChangeKind` 联合当成
 * 字符串读会得到 `"[object Object]"`。
 * ⚠️ `diff` 是**标准 unified diff**:`+`/`-` 后面**没有空格**(`+    76: …`)。
 * `ArtifactPreview` 里那个 `DiffView` 现在两种都认(见它的注释)。
 *
 * ## 去重口径:一个路径一条
 *
 * 同一条会话里,同一个文件常常被改十几次(实测某条会话里同一份 `.py` 被 5 个
 * `exec-*` item 改过)。列表要的是"这条会话动过哪些文件",不是"改过几次" ——
 * 所以按 path 去重,**留最新那一次**的 diff。这与 Claude 那边
 * (`ON CONFLICT(id) DO UPDATE`)是同一条口径。
 */

/** 一次翻多少条 item。产物只关心 fileChange,给大一点能少翻几趟 */
const SCAN_PAGE = 200;
/**
 * 最多翻几页。
 *
 * ⚠️ 设上限是**故意的**:产物列表是"顺路看一眼"的东西,不该为它把一条几百轮的
 * 会话整个读完 —— 这条链路上每个来回都要好几秒。到顶了会**照实说**
 * (`complete: false`),而不是假装完整。
 */
const MAX_SCAN_PAGES = 4;

interface RawChange {
  path?: unknown;
  kind?: unknown;
  diff?: unknown;
}

/** `{type: "update"}` / 万一上游哪天改成字符串,两种都读得出来 */
function changeKindLabel(kind: unknown): string {
  if (typeof kind === "string") return kind;
  const t = (kind as { type?: unknown } | undefined)?.type;
  return typeof t === "string" ? t : "change";
}

interface Found {
  /** 解析过的绝对路径 */
  absPath: string;
  /** 最新那一次的改动类型(add / update / delete) */
  kindLabel: string;
  diff: string;
  /** 最近一次改动的时刻(ISO)。取不到就是 null */
  at: string | null;
}

function isoOfMs(v: unknown): string | null {
  const n = typeof v === "number" && Number.isFinite(v) ? v : null;
  if (n === null) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `thread/items/list` 一页回来的形状。取名字是为了别把那个 type 参数写成一大坨 ——
 *  TS 对"内联对象类型 + 循环里回写变量"会推成环,报 TS7022(踩过) */
interface ItemsPage {
  data?: { item?: unknown; completedAtMs?: unknown; startedAtMs?: unknown }[];
  nextCursor?: unknown;
}

/**
 * 翻这条会话的 item,收集"动过哪些文件"。
 *
 * ⚠️ 必须 `sortDirection: "desc"` —— 一是与 `readThread` 同一个方向(见 `ITEM_PAGE`
 * 上面那段,默认升序是个坑),二是**倒着走才能"第一次见到的就是最新那次"**,
 * 于是去重不需要记时间戳比大小。
 */
async function scanChanges(
  threadId: string,
  cwd: string | null,
): Promise<{ found: Map<string, Found>; complete: boolean }> {
  const found = new Map<string, Found>();
  let cursor: string | null = null;
  let complete = false;

  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const res: ItemsPage = await codexClient().call<ItemsPage>("thread/items/list", {
      threadId,
      limit: SCAN_PAGE,
      sortDirection: "desc",
      cursor,
    });
    const entries = res.data ?? [];

    for (const entry of entries) {
      const item = entry?.item as { type?: unknown; changes?: unknown } | undefined;
      if (item?.type !== "fileChange" || !Array.isArray(item.changes)) continue;
      const at = isoOfMs(entry.completedAtMs ?? entry.startedAtMs);
      for (const raw of item.changes as RawChange[]) {
        const p = typeof raw?.path === "string" ? raw.path : null;
        if (!p) continue;
        // ⚠️ 实测是绝对路径,但相对的话必须按**这条会话的 cwd** 解析 ——
        //    拿后端的 cwd(server/)去解析会得到一条根本不存在的路径,而那个错
        //    只在"打开某个文件"时才现形。
        const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd ?? process.cwd(), p);
        if (found.has(abs)) continue; // 倒序走 —— 先见到的那条就是最新的
        found.set(abs, {
          absPath: abs,
          kindLabel: changeKindLabel(raw.kind),
          diff: typeof raw.diff === "string" ? raw.diff : "",
          at,
        });
      }
    }

    cursor = typeof res.nextCursor === "string" && res.nextCursor ? res.nextCursor : null;
    if (!cursor) {
      complete = true;
      break;
    }
  }

  return { found, complete };
}

function sizeOf(absPath: string): number {
  try {
    return fs.statSync(absPath).size;
  } catch {
    // 文件已经不在了(被删/被改名)是**常态**:产物记的是"当时动过它"。
    // 拿不到大小就给 0,和 Claude 那条路一致。
    return 0;
  }
}

/**
 * 这条会话动过的文件。
 *
 * ⚠️ `sessionId` 填的是 **thread id** —— 与 Claude 那边的 "ccSessionId" 在同一个
 * 字段位置上,界面上都不需要知道自己在看哪一边。
 */
export async function listArtifacts(
  threadId: string,
): Promise<{ artifacts: ArtifactSummary[]; complete: boolean }> {
  const thread = await readThreadSummary(threadId);
  const { found, complete } = await scanChanges(threadId, thread.cwd);

  const artifacts: ArtifactSummary[] = [];
  for (const f of found.values()) {
    artifacts.push({
      id: artifactIdOf(threadId, f.absPath),
      sessionId: threadId,
      path: f.absPath,
      kind: kindOf(f.absPath),
      size: sizeOf(f.absPath),
      createdAt: f.at ?? thread.updatedAt ?? new Date().toISOString(),
      // 缩略图那条路是跟着 Claude 的索引器走的,Codex 这边没有
      hasThumb: false,
    });
  }
  // 新的在前 —— 与"最近改了什么"这个用途一致
  artifacts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { artifacts, complete };
}

/** 预览的体积上限。与 Claude 那条(`routes/artifacts.ts`)同一个数 */
const MAX_PREVIEW_BYTES = 256 * 1024;

const TEXT_EXT = new Set([
  ".txt", ".log", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".sh", ".ps1", ".bat", ".cmd", ".sql",
  ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".tex", ".css", ".scss", ".html", ".vue",
]);

function isTexty(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".json" || ext === ".md" || ext === ".markdown" || TEXT_EXT.has(ext);
}

/**
 * 一个产物的详情。
 *
 * `diff` = **最新那一次**的补丁(见文件头的去重口径);
 * `content` = 这个文件**现在**的内容(超过上限或不是文本就给 null,界面会提示去下载)。
 *
 * ⚠️ 两者语义不同但都值得给:补丁回答"改了什么",内容回答"现在长什么样"。
 * `ArtifactPreview` 本来就把这两块分开渲染,所以不用改它。
 */
export async function readArtifact(threadId: string, artifactId: string): Promise<ArtifactDetail | null> {
  const thread = await readThreadSummary(threadId);
  const { found } = await scanChanges(threadId, thread.cwd);

  for (const f of found.values()) {
    if (artifactIdOf(threadId, f.absPath) !== artifactId) continue;

    let content: string | null = null;
    const size = sizeOf(f.absPath);
    if (isTexty(f.absPath) && size > 0 && size <= MAX_PREVIEW_BYTES) {
      try {
        content = await fsp.readFile(f.absPath, "utf8");
      } catch {
        // 读不动就当没有 —— 详情面板会说"可以用下面的按钮下载到手机"
        content = null;
      }
    }

    return {
      id: artifactId,
      sessionId: threadId,
      path: f.absPath,
      kind: kindOf(f.absPath),
      size,
      createdAt: f.at ?? thread.updatedAt ?? new Date().toISOString(),
      hasThumb: false,
      content,
      diff: f.diff || null,
    };
  }
  return null;
}
