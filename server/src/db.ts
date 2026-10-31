import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, "remote-cc.db"));

/**
 * ⚠️ `busy_timeout` **必须有**(2026-10-13 加的)。
 *
 * 这个库文件**有两个进程在用**:主后端(`index.ts`)与救援进程(`rescue.ts`,端口 8788)。
 * 而 `node:sqlite` 的默认 busy timeout 是 **0** —— 撞上一次就立刻抛 `SQLITE_BUSY`。
 *
 * 代价在 2026-10-13 19:25 那次实测到了:后端崩掉之后 watchdog 重跑 bootstrap,
 * 新后端在 `ensureMessageDedupe`(`history/indexer.ts:91`,建唯一索引,要独占写锁)
 * 那一刻正好撞上救援进程 → **`Error: database is locked` → 新后端当场退出**,
 * boot.log 里只有一句"后端 启动失败"。5 分钟后再试一次才碰巧成功 ——
 * 也就是说**自动恢复成了一个概率事件**。
 *
 * 5 秒足够任何一方把手头那笔短事务做完;真的卡满 5 秒仍会抛(那时确实出事了)。
 */
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  file_path     TEXT NOT NULL,
  project_path  TEXT,
  title         TEXT,
  last_prompt   TEXT,
  created_at    TEXT,
  updated_at    TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  parsed_offset INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  uuid       TEXT,
  role       TEXT NOT NULL,
  ts         TEXT,
  content    TEXT NOT NULL,
  raw_offset INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  path       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  sha256     TEXT,
  thumb_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at DESC);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash);

CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  device_id TEXT,
  action    TEXT NOT NULL,
  target    TEXT,
  result    TEXT NOT NULL,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 账单的原料:一次 API 响应一行。
--
-- ⚠️ 主键是 **jsonl 里的 message.id**,不是消息 uuid —— 同一条响应会按 content block
-- 落成多条 assistant 条目、usage 每条都原样重复(实测最多 5 次)。拿这个主键 + OR IGNORE
-- 去重,是按条目累加会多算好几倍的唯一防线。
CREATE TABLE IF NOT EXISTS usage (
  msg_id      TEXT PRIMARY KEY,
  session_id  TEXT,
  ts          TEXT,
  model       TEXT,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);

-- 用量扫描的游标(每个 jsonl 一个),和消息索引的 parsed_offset **各走各的**。
--
-- 为什么要单独一套:消息索引是按 parsed_offset 增量走的,历史消息**永远不会被重新
-- 解析** —— 想给它们补上用量就得整库重建(401MB / 115 个文件,不现实)。用量这边
-- 只在"今日"范围内要,所以按文件 mtime 筛掉今天没动过的文件、只往前走,代价很小。
CREATE TABLE IF NOT EXISTS usage_scan (
  session_id TEXT PRIMARY KEY,
  file_path  TEXT NOT NULL,
  offset     INTEGER NOT NULL DEFAULT 0
);
`);

export function nowIso(): string {
  return new Date().toISOString();
}

function addColumnIfMissing(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("artifacts", "meta", "TEXT");
addColumnIfMissing("artifacts", "session_title", "TEXT");
/** 标题来源(custom/ai/prompt)—— 索引器靠它防止 AI 标题被用户消息降级覆盖 */
addColumnIfMissing("sessions", "title_source", "TEXT");
/**
 * 归档。
 *
 * ⚠️ `NOT NULL DEFAULT 0` 是**故意的**:库里原本那一堆会话从没提过归档,它们当然
 * 是"没归档"。列留成可空的话,每处查询都要写 `COALESCE(archived, 0)`,总有一处会漏。
 *
 * 内容的**真值**在 jsonl 里(一条 `{"type":"custom-archived",…}`),这两列是派生的 ——
 * 库可以随便删(见根 CLAUDE.md),删了下次全量索引会从 jsonl 里重新读出来。
 */
addColumnIfMissing("sessions", "archived", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("sessions", "archived_at", "TEXT");

/**
 * node:sqlite 的返回类型是 Record<string, SQLOutputValue>,与行接口不重叠,
 * 所以把断言收在这两个助手里,调用处保持干净。
 */
export function allRows<T>(sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function oneRow<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function kvGet(key: string): string | null {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

export function kvSet(key: string, value: string): void {
  db.prepare(
    "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
  ).run(key, value);
}

export function recordAudit(
  deviceId: string | null,
  action: string,
  target: string | null,
  result: "ok" | "denied" | "error",
  detail?: string,
): void {
  db.prepare(
    "INSERT INTO audit (ts, device_id, action, target, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(nowIso(), deviceId, action, target, result, detail ?? null);
}
