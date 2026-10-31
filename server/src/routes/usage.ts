import type { FastifyInstance } from "fastify";
import type { UsageResponse, UsageRow } from "@remote-cc/shared";
import { allRows } from "../db.ts";
import { scanUsageOnce, scannerFresh } from "../history/usage.ts";

interface UsageDbRow {
  ts: string;
  model: string | null;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** 本地零点。"今日"按**本地日**算 —— 和界面上写着的日期一致,不然跨零点会对不上 */
function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * 账单的原料接口。
 *
 * 回的是**逐条**用量而不是一个总数:峰谷计价要靠每条自己的时间,汇成一坨就没法按
 * 时段分价了。条数按一个繁忙日的量级给足(20000),界面只取今日 + 近一小时。
 */
export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/usage", async (req) => {
    const { since } = req.query as { since?: string };
    const from = /^\d{4}-\d{2}-\d{2}T/.test(since ?? "") ? (since as string) : startOfTodayIso();

    // 后台扫描器每 10 秒才走一次;第一次打开账单时它可能刚重启、一条都还没有。
    // 空账单比数字旧更让人困惑,所以只在它没在跟的时候同步补一轮(代价有上限)。
    if (!scannerFresh()) scanUsageOnce();

    const rows = allRows<UsageDbRow>(
      `SELECT ts, model, input, output, cache_read, cache_write FROM usage
        WHERE ts IS NOT NULL AND ts >= ? ORDER BY ts ASC LIMIT 20000`,
      from,
    );

    // 只列**真的花过 token** 的模型:CLI 会写 `<synthetic>` 这种 0 用量的占位,它不是
    // 一个能配价的模型,混进"点一下就能选"的列表里只会让人困惑
    const models = allRows<{ model: string }>(
      `SELECT DISTINCT model FROM usage
        WHERE model IS NOT NULL AND model <> ''
          AND (input + output + cache_read + cache_write) > 0
        ORDER BY model`,
    ).map((r) => r.model);

    const out: UsageResponse = {
      since: from,
      rows: rows.map(
        (r): UsageRow => ({
          ts: r.ts,
          model: r.model,
          input: r.input,
          output: r.output,
          cacheRead: r.cache_read,
          cacheWrite: r.cache_write,
        }),
      ),
      models,
    };
    return out;
  });
}
