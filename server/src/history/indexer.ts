import fs from "node:fs";
import type { TitleSource } from "@remote-cc/shared";
import { db, kvGet, kvSet, nowIso } from "../db.ts";
import { parseSession, sessionFiles } from "./parser.ts";

/** 标题来源的优先级。数字大的不会被数字小的盖掉 */
const TITLE_RANK: Record<TitleSource, number> = { prompt: 1, ai: 2, custom: 3 };

/**
 * 决定这次要不要换标题。
 *
 * ⚠️ 这是"标题会莫名其妙变回一句话"的解药。索引是**增量**的,某一次新解析的
 * 那一段里往往只有用户消息(没有 ai-title 行),而解析器只能拿首条用户消息顶替。
 *
 * ⚠️ 2026-09-19 又补了一次:光"不降级"还不够。`prompt` 档的候选来自**本段**的
 * 首条用户消息 —— 而本段的首条**不是**整个会话的首条。同等级之间若允许互相覆盖,
 * 每解析一段标题就被顶掉一次,最后停在哪一段纯属运气:实测有会话的标题变成了
 * `[Request interrupted by user for tool use]`,因为最后一次索引那段的"首条"正是那条
 * 中断标记(用户中断了一次工具调用)。
 *
 * 规则:
 *   - `prompt`(最低档)**只能填空,永远不覆盖已有标题**
 *   - `ai` / `custom` 之间允许同等级替换 —— AI 标题会随对话演进重生成,
 *     用户在桌面端改名也该立刻生效
 */
function pickTitle(
  prevTitle: string | null,
  prevSource: TitleSource | null,
  nextTitle: string | null,
  nextSource: TitleSource | null,
): { title: string | null; source: TitleSource | null } {
  if (!nextTitle) return { title: prevTitle, source: prevSource };
  if (!prevTitle) return { title: nextTitle, source: nextSource };
  // prompt 档到这里就结束:上面两行已经处理了"没有标题时拿它填空",
  // 已有标题时它不该有机会覆盖 —— 它只是本段的首条消息,不代表整个会话。
  if (nextSource === "prompt") return { title: prevTitle, source: prevSource };
  const prevRank = prevSource ? TITLE_RANK[prevSource] : 0;
  const nextRank = nextSource ? TITLE_RANK[nextSource] : 0;
  if (nextRank >= prevRank) return { title: nextTitle, source: nextSource };
  return { title: prevTitle, source: prevSource };
}

/**
 * 解析器版本。
 *
 * ⚠️ 改 `blocksFromContent` 产出的形状时**必须**把它 +1。
 *
 * 索引是按 `parsed_offset` 增量建的,已经入库的消息**永远不会被重新解析** ——
 * 老解析器写进去的形状会一直留在库里,新代码只对新消息生效。这个坑很隐蔽:
 * 改了代码、类型也过了、新会话看着正常,而翻旧会话还是老样子,很容易以为
 * 改错了地方。把它 +1 就会自动重建一次。
 *
 * ⚠️ 反过来也成立:**不是形状变了就别动它。** 2026-09-20 修 `project_path` 的取值
 * 规则时一度 +1 过,那是过度反应 —— 消息索引跟这件事没关系,而重建要同步重解析
 * 全部 jsonl(其中一份 33MB),能把后端卡住几十秒。那种"旧值洗不掉"的问题改用
 * 一次性修数脚本(`server/scripts/fix-session-project-path.mjs`),对症也便宜。
 */
const PARSER_VERSION = 6;
const PARSER_VERSION_KEY = "parser_version";

/**
 * 版本对不上就把消息索引整个丢掉重建。
 *
 * `messages` 是纯派生数据(jsonl 才是权威源),重建是安全的;
 * **不要**碰 sessions / devices / audit —— devices 一丢,手机就掉线了。
 */
function reindexIfParserChanged(): void {
  const stored = kvGet(PARSER_VERSION_KEY);
  if (stored === String(PARSER_VERSION)) return;
  db.exec("DELETE FROM messages");
  db.exec("UPDATE sessions SET parsed_offset = 0, message_count = 0");
  kvSet(PARSER_VERSION_KEY, String(PARSER_VERSION));
  console.log(`[index] 解析器版本 ${stored ?? "(首次)"} → ${PARSER_VERSION},消息索引已重建`);
}

reindexIfParserChanged();

/**
 * 同一个 uuid 只留一行。
 *
 * ⚠️ 这不是洁癖。CLI **每次压缩上下文都会把"保留段"原样重新追加一遍** ——
 * 实测某个会话里同一条 `/compact` 出现 3 次(该会话压过 7 次,见 jsonl 的
 * `compact_boundary` 条目)。而解析是按**字节游标增量**走的:每个重放出来的副本
 * 都被当作新消息再入一次库,于是手机上同一条消息会显示两三遍,而且越压越多。
 *
 * 去重只能在库这一层做 —— 解析器一次只看一个切片,跨切片的重放它看不见。
 *
 * ⚠️ 建唯一索引**之前必须先清历史重复行**,否则这一步会直接失败(老库里已经有重复)。
 */
function ensureMessageDedupe(): void {
  db.exec(
    `DELETE FROM messages
      WHERE uuid IS NOT NULL
        AND rowid NOT IN (
          SELECT MIN(rowid) FROM messages WHERE uuid IS NOT NULL GROUP BY session_id, uuid
        )`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_uuid
       ON messages(session_id, uuid) WHERE uuid IS NOT NULL`,
  );
}

ensureMessageDedupe();

let lastIndexAt = 0;
const INDEX_THROTTLE_MS = 2000;

interface OffsetRow {
  parsed_offset: number;
}

function offsetOf(id: string): number {
  const row = db.prepare("SELECT parsed_offset FROM sessions WHERE id = ?").get(id) as OffsetRow | undefined;
  return row?.parsed_offset ?? 0;
}

export function indexSession(id: string, filePath: string): void {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return;
  }

  let offset = offsetOf(id);
  if (size < offset) {
    // 文件被重写(如压缩历史),游标失效,整体重解析
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    offset = 0;
  }
  if (size === offset) return;

  const parsed = parseSession(filePath, offset, id);

  // OR IGNORE:压缩会把保留段重放出来(见 ensureMessageDedupe 的说明),
  // 同一个 uuid 撞上唯一索引时直接跳过,而不是让整次索引报错
  const insert = db.prepare(
    "INSERT OR IGNORE INTO messages (session_id, uuid, role, ts, content, raw_offset) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const m of parsed.messages) {
    insert.run(id, m.uuid, m.role, m.ts, JSON.stringify(m.blocks), parsed.nextOffset);
  }

  const existing = db
    .prepare("SELECT id, title, title_source, archived, archived_at FROM sessions WHERE id = ?")
    .get(id) as
    | {
        id: string;
        title: string | null;
        title_source: TitleSource | null;
        archived: number | null;
        archived_at: string | null;
      }
    | undefined;
  const count = (
    db.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get(id) as { c: number }
  ).c;

  if (existing) {
    const title = pickTitle(existing.title, existing.title_source, parsed.title, parsed.titleSource);
    /**
     * ⚠️ `project_path` 的取值顺序是**有讲究的**(使用者报的「会话老是乱跳」):
     *
     *   1. `relocatedCwd` —— CLI 显式说"这个会话搬到别处了",允许改
     *   2. `cwd` —— **只在库里还是空的时候**才填(解析器保证它只在"整段从文件头解析"
     *      时才有值,见 ParsedSession.cwd)。原来写的是 `COALESCE(?, project_path)`,
     *      也就是只要解析出东西就覆盖 —— 而解析器那时候给的是"本段最后一条带 cwd 的
     *      条目",于是会话的分组目录跟着 agent 的 `cd` 到处跑,甚至跑进 node_modules。
     *   3. 已经有了就不动。
     *
     * 顺序不能调:调了就成了"顺手 cd 也能改身份",那正是要修的毛病。
     */
    /**
     * 归档状态的合并**写在 TS 里,不写成 SQL 的 `COALESCE`**。
     *
     * `archived` 用 COALESCE 是对的(和 `project_path` 同一个套路:`null` = 这段切片
     * 没提到,保留库里的值)。但 `archived_at` **不行** —— 取消归档时它必须被清成 null,
     * 而 COALESCE(null, archived_at) 会原样留住旧的"归档于 9 月 20 日",界面上就出现
     * 一个明明没归档、却写着归档时间的条目。
     *
     * 两个字段的合并规则不一样,拆成两条 SQL 表达式反而容易在下次改动时看漏一条,
     * 所以放在这儿一次说清:`archived` 为 null 就两个字段都别动,否则一起按新的来。
     */
    const archived = parsed.archived === null ? (existing.archived ?? 0) : parsed.archived ? 1 : 0;
    const archivedAt = parsed.archived === null ? existing.archived_at : parsed.archivedAt;

    db.prepare(
      `UPDATE sessions SET
         file_path = ?, project_path = COALESCE(?, ?, project_path),
         title = ?, title_source = ?,
         last_prompt = COALESCE(?, last_prompt), created_at = COALESCE(created_at, ?),
         updated_at = COALESCE(?, updated_at), message_count = ?, parsed_offset = ?,
         archived = ?, archived_at = ?
       WHERE id = ?`,
    ).run(
      filePath,
      parsed.relocatedCwd,
      parsed.cwd,
      title.title,
      title.source,
      parsed.lastPrompt,
      parsed.createdAt,
      parsed.updatedAt,
      count,
      parsed.nextOffset,
      archived,
      archivedAt,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO sessions (id, file_path, project_path, title, title_source, last_prompt, created_at, updated_at, message_count, parsed_offset, archived, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      filePath,
      parsed.relocatedCwd ?? parsed.cwd,
      parsed.title,
      parsed.titleSource,
      parsed.lastPrompt,
      parsed.createdAt ?? nowIso(),
      parsed.updatedAt ?? nowIso(),
      count,
      parsed.nextOffset,
      // 新会话只会是"没归档"或"归档",不存在"没提到"这一态(null → 0)
      parsed.archived ? 1 : 0,
      parsed.archivedAt,
    );
  }
}

/** 增量扫描全部会话文件;文件未增长时只做一次 stat,足够便宜,可在列表请求里调用 */
export function ensureIndexFresh(force = false): void {
  const now = Date.now();
  if (!force && now - lastIndexAt < INDEX_THROTTLE_MS) return;
  lastIndexAt = now;

  const files = sessionFiles();
  const seen = new Set<string>();
  for (const f of files) {
    seen.add(f.filePath);
    indexSession(f.id, f.filePath);
  }

  // 清理已不存在的会话文件,避免列表里出现幽灵条目
  const rows = db.prepare("SELECT id, file_path FROM sessions").all() as { id: string; file_path: string }[];
  for (const row of rows) {
    if (!seen.has(row.file_path)) {
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(row.id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
    }
  }
}
