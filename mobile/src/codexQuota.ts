import type { CodexQuotaResponse, CodexQuotaWindow } from "./shared";

/**
 * Codex 额度怎么显示 —— 把后端那份快照变成几行给人看的东西。
 *
 * ⚠️ **纯函数、不 import React/expo** —— 与 `messageMerge.ts` / `billing.ts` /
 * `appUpdate.ts` 同一个理由:能在裸 Node 里跑用例(`scripts/check-codex-quota.mjs`)。
 * 这里唯一容易错的是**时间换算**(unix 秒 vs 毫秒、跨小时跨天、"已重置"的边界),
 * 而那正是最该有用例的地方 —— 算错了只是"倒计时不对",不装包看不出来。
 *
 * `now` 一律由调用方传进来(毫秒),不在里面读时钟 —— 否则用例就得靠等。
 */

export interface QuotaRow {
  /** 「5 小时窗口」这种 */
  label: string;
  /** 0–100 */
  percent: number;
  /** 0–1,给进度条用 */
  ratio: number;
  /** 「2 小时 5 分后重置」。取不到重置时刻就是空串(界面别画那一行) */
  resetHint: string;
}

/**
 * 窗口名从**时长**推,不写死「primary / secondary」。
 *
 * Plus 是 5 小时 + 7 天,但别的套餐窗口不一样,而这套 API 是按窗口长度表达的 ——
 * 写死标签会在换套餐时变成错的。
 */
export function windowLabel(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return "额度窗口";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天窗口`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
  return `${Math.round(minutes)} 分钟窗口`;
}

/**
 * 距离重置还有多久。`resetsAt` 是 **unix 秒**(不是毫秒)。
 *
 * 已经过了重置点(或时钟偏差导致差值为负)一律说「已重置」—— 那比显示
 * 「0 分钟」或者一个负数有用:它意味着这个窗口现在是空的。
 */
export function describeReset(resetsAt: number | null, nowMs: number): string {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return "";
  const deltaSec = resetsAt - Math.floor(nowMs / 1000);
  if (deltaSec <= 0) return "已重置";

  const mins = Math.floor(deltaSec / 60);
  if (mins < 1) return "不到 1 分钟后重置";
  if (mins < 60) return `${mins} 分钟后重置`;

  const hours = Math.floor(mins / 60);
  const restMin = mins % 60;
  // ≥ 24 小时就说天 —— 「157 小时后」没人换算得过来(7 天窗口常态)
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const restHour = hours % 24;
    return restHour === 0 ? `${days} 天后重置` : `${days} 天 ${restHour} 小时后重置`;
  }
  return restMin === 0 ? `${hours} 小时后重置` : `${hours} 小时 ${restMin} 分后重置`;
}

/**
 * 一个窗口 → 一行。**没有用量就没有这一行**(返回 null)。
 *
 * 后端保证了 `usedPercent` 一定有(没有就整个窗口给 null),所以这里不必再兜 ——
 * 但 `ratio` 仍夹到 0–1,免得将来上游给了个 150 把进度条画到框外面去。
 */
export function describeWindow(w: CodexQuotaWindow | null, nowMs: number): QuotaRow | null {
  if (!w) return null;
  const percent = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
  return {
    label: windowLabel(w.windowMinutes),
    percent,
    ratio: percent / 100,
    resetHint: describeReset(w.resetsAt, nowMs),
  };
}

/** 面板要显示的全部东西 —— 一次算好,界面那层不做判断 */
export interface QuotaView {
  rows: QuotaRow[];
  /** 套餐名(大写好看些)。取不到就空串 */
  plan: string;
  /** 余额。取不到就 null */
  balance: string | null;
  /** 此刻是不是已经被挡住了 */
  blocked: boolean;
  /** 还有几次没用的重置额度 */
  resetCredits: number;
  /** 「截至 3 分钟前」—— 快照有多新 */
  ageHint: string;
}

/**
 * 快照有多新。
 *
 * ⚠️ 这一条**必须有**:额度是快照,而它会在别处(桌面端、命令行)跑过 Codex 之后变化。
 * 不标出"截至多久之前",使用者会以为数字是此刻的,然后在别处跑完发现对不上而怀疑坏了。
 */
export function describeAge(fetchedAtIso: string, nowMs: number): string {
  const t = Date.parse(fetchedAtIso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.floor((nowMs - t) / 1000);
  if (sec < 60) return "刚刚";
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function buildQuotaView(q: CodexQuotaResponse, nowMs: number): QuotaView {
  const rows = [describeWindow(q.primary, nowMs), describeWindow(q.secondary, nowMs)].filter(
    (r): r is QuotaRow => r !== null,
  );
  return {
    rows,
    plan: q.planType ? q.planType.toUpperCase() : "",
    balance: q.creditBalance,
    blocked: q.blocked,
    resetCredits: q.resetCredits,
    ageHint: describeAge(q.fetchedAt, nowMs),
  };
}
