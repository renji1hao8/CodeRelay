import type { FastifyInstance } from "fastify";
import type { CodexQuotaResponse, CodexQuotaWindow } from "@remote-cc/shared";
import { codexClient } from "../codex/client.ts";
import { httpError } from "../http.ts";

/**
 * Codex 的额度 —— 手机上能看 ChatGPT Plus 还剩多少、什么时候重置。
 *
 * ## 为什么它不花 token
 *
 * 走的是 Codex app-server 的 `account/rateLimits/read`,那是**一次协议调用**,
 * 不是一次模型请求。所以手机端可以一点就刷新,不必担心"看一眼额度反而把额度花了"。
 * (对比之下,另一条笨办法是"跑一次 codex 再翻它写下的快照" —— 那要花钱。)
 *
 * ## 为什么要缓存
 *
 * 每次读都要:起一次协议往返 + 一次上游 HTTP。而额度本来就是个慢变量。
 * 20 秒的窗口足够让"点两下"不至于打两次上游,又不至于让数字看起来是陈的 ——
 * 而且返回值里带着 `fetchedAt`,手机端能照实说"截至多久之前"。
 *
 * ## 失败为什么要说人话
 *
 * 最常见的失败是**这台机器上没装独立的 Codex CLI**(桌面端自带的那个不算)。
 * 那对使用者是"去装一下",不是"出错了" —— 所以回 503 并把原因带出去,
 * 而不是让上游抛一个 ENOENT 冒到手机上变成一句看不懂的话。
 */

const CACHE_TTL_MS = 20_000;

let cache: { at: number; value: CodexQuotaResponse } | null = null;

interface RawWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}
interface RawRateLimits {
  planType?: unknown;
  primary?: RawWindow | null;
  secondary?: RawWindow | null;
  credits?: { balance?: unknown } | null;
}
interface RawQuota {
  ordinaryUsageAllowed?: unknown;
  rateLimits?: RawRateLimits | null;
  rateLimitResetCredits?: { availableCount?: unknown } | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 一个窗口。**没有 `usedPercent` 就当"没有这个窗口"**(返回 null)——
 * 用量是它唯一必填的东西,缺了它这一行画不出来,给个 0 只会谎报"还剩很多"。
 */
function windowOf(w: RawWindow | null | undefined): CodexQuotaWindow | null {
  if (!w || typeof w !== "object") return null;
  const used = num(w.usedPercent);
  if (used === null) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round(used))),
    windowMinutes: num(w.windowDurationMins),
    resetsAt: num(w.resetsAt),
  };
}

export async function codexRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/codex/quota", async () => {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

    let raw: RawQuota;
    try {
      raw = await codexClient().call<RawQuota>("account/rateLimits/read", {});
    } catch (err) {
      // ⚠️ 缓存**只在成功时**写。失败不留缓存 —— 否则"装好了 Codex"之后
      // 还要多等一个 TTL 才看得到它。
      throw httpError(503, `读不到 Codex 额度:${err instanceof Error ? err.message : String(err)}`);
    }

    const rl = raw?.rateLimits ?? null;
    const resetCredits = num(raw?.rateLimitResetCredits?.availableCount);

    const value: CodexQuotaResponse = {
      planType: typeof rl?.planType === "string" ? rl.planType : null,
      primary: windowOf(rl?.primary),
      secondary: windowOf(rl?.secondary),
      creditBalance: typeof rl?.credits?.balance === "string" ? rl.credits.balance : null,
      // ⚠️ 只有**明确**给了 false 才算"被挡"。上游给 null 是"不知道",不是"没被挡"
      // —— 把"不知道"显示成"没被挡"会让人以为还能跑,那种误解比不显示更糟
      blocked: raw?.ordinaryUsageAllowed === false,
      resetCredits: resetCredits === null ? 0 : Math.max(0, Math.trunc(resetCredits)),
      fetchedAt: new Date().toISOString(),
    };

    cache = { at: Date.now(), value };
    return value;
  });
}
