/**
 * 用量扫描:把 jsonl 里的 `usage` 收进库,给账单当原料。
 *
 * 为什么不复用消息索引的游标:那个游标是 `parsed_offset`,历史消息**永远不会被重新
 * 解析** —— 想给它们补上用量就得整库重建(401MB / 115 个文件,不现实,还会把手机
 * 那次请求堵住)。而账单只要"今日 + 近一小时",所以这里的策略是:
 *
 * 1. **按 mtime 筛**:今天(或最近两小时,照顾刚过零点那一段)没动过的 jsonl 不可能
 *    有今天的用量,直接记成"已扫到文件末尾"跳过。
 * 2. **自己的游标**:每个文件一行记在 `usage_scan` 表里,只往前走。
 * 3. **分片**:每次 tick 只花一小段时间(预算内),在后台慢慢填,不挡任何请求。
 *
 * ⚠️ 去重靠 `usage` 表的主键(`message.id`)。同一条 API 响应会按 content block 落成
 * 多条条目、`usage` 每条都原样重复 —— 按条目累加会把账单算成好几倍,而且数字只是偏大,
 * 一眼看不出来。解析器**故意不去重**(它一次只看一个切片,跨切片的重放它看不见)。
 */
import fs from "node:fs";
import { db } from "../db.ts";
import { parseSession, sessionFiles, type SessionFile } from "./parser.ts";

/** 后台补数据的节奏:每 10 秒看一眼有没有新内容 */
const TICK_MS = 10_000;
/** 单次 tick 最多花多少时间在解析上 —— 后台活儿,不许挡着谁 */
const BUDGET_MS = 1_200;
/** 表里最新一条比这个还旧,就当它"没在跟"了(见 routes/usage.ts 的说明) */
export const STALE_AFTER_MS = 5 * 60_000;

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 这个文件值得从头扫吗:今天动过,或者最近两小时内动过(跨零点时"近一小时"跨昨天) */
function worthScanning(mtimeMs: number): boolean {
  return mtimeMs >= startOfTodayMs() || mtimeMs >= Date.now() - 2 * 3_600_000;
}

function saveCursor(f: SessionFile, offset: number): void {
  db.prepare(
    `INSERT INTO usage_scan (session_id, file_path, offset) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET offset = excluded.offset, file_path = excluded.file_path`,
  ).run(f.id, f.filePath, offset);
}

function cursorOf(id: string): number | null {
  const row = db.prepare("SELECT offset FROM usage_scan WHERE session_id = ?").get(id) as
    | { offset: number }
    | undefined;
  return row ? row.offset : null;
}

function scanFile(f: SessionFile): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(f.filePath);
  } catch {
    return;
  }

  const known = cursorOf(f.id);
  let offset: number;
  if (known !== null) {
    if (st.size <= known) return; // 没有新内容
    offset = known;
  } else if (worthScanning(st.mtimeMs)) {
    offset = 0; // 首次 + 今天动过 → 从头扫(这种文件本身就是今天写的,不大)
  } else {
    saveCursor(f, st.size); // 今天没动过 → 记成末尾,以后只跟着新增走
    return;
  }
  if (st.size < offset) offset = 0; // 文件被重写(如压缩历史),游标失效

  const parsed = parseSession(f.filePath, offset, f.id);
  if (parsed.usage.length > 0) {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO usage (msg_id, session_id, ts, model, input, output, cache_read, cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const u of parsed.usage) {
      insert.run(u.msgId, f.id, u.ts, u.model, u.input, u.output, u.cacheRead, u.cacheWrite);
    }
  }
  saveCursor(f, parsed.nextOffset);
}

/** 扫一轮,时间到了就停(下次 tick 接着走)。返回这轮扫了几个文件 */
export function scanUsageOnce(): number {
  const deadline = Date.now() + BUDGET_MS;
  let scanned = 0;
  lastScanAt = Date.now();
  for (const f of sessionFiles()) {
    if (Date.now() > deadline) break;
    scanFile(f);
    scanned += 1;
  }
  return scanned;
}

let lastScanAt = 0;

/**
 * 扫描器最近跟得上吗。
 *
 * 给路由用:后台每 10 秒走一次,但"刚重启完第一次打开账单"很可能一条数据都没有 ——
 * 空账单比数字旧更让人困惑。所以路由在它**明显没在跟**的时候同步补一轮(代价有上限
 * BUDGET_MS),平时不花这个钱。
 */
export function scannerFresh(withinMs = 30_000): boolean {
  return Date.now() - lastScanAt < withinMs;
}

/** 表里最新一条的时间戳;空表返回 null */
export function latestUsageTs(): string | null {
  const row = db.prepare("SELECT ts FROM usage WHERE ts IS NOT NULL ORDER BY ts DESC LIMIT 1").get() as
    | { ts: string }
    | undefined;
  return row?.ts ?? null;
}

export function startUsageScanner(): void {
  const timer = setInterval(() => {
    try {
      scanUsageOnce();
    } catch (err) {
      // 扫描失败不该影响任何别的东西 —— 下一轮还会再试
      console.warn("[usage] 扫描出错:", String(err));
    }
  }, TICK_MS);
  timer.unref?.();
}
