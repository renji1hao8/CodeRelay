import type { AccountQuotaRow } from "@remote-cc/shared";
const number = (n: unknown): number | undefined => n !== null && n !== "" && Number.isFinite(Number(n)) ? Number(n) : undefined;
export function resetTime(n: unknown): string | null {
  if (typeof n === "string" && !/^\d+(\.\d+)?$/.test(n)) return Number.isNaN(Date.parse(n)) ? null : new Date(n).toISOString();
  const value = number(n); return value && value > 0 ? new Date(value < 1e12 ? value * 1000 : value).toISOString() : null;
}
export function remainingRow(label: string, used: unknown, total?: unknown, resetsAt?: unknown, unit?: string): AccountQuotaRow {
  const u = number(used), t = number(total);
  return { label, used: u, total: t, unit, resetsAt: resetTime(resetsAt),
    ...(u !== undefined && t !== undefined && t > 0 ? { remaining: Math.max(0, t - u), remainingPercent: Math.max(0, Math.min(100, (1 - u / t) * 100)) } : {}),
  };
}
export function parseQuota(kind: string, raw: any): AccountQuotaRow[] {
  if (kind === "opencode_go") return Object.entries(raw.usage ?? {})
    .filter(([key, value]: any) => ["rolling", "weekly", "monthly"].includes(key) && number(value?.percent) !== undefined)
    .map(([key, value]: any) => remainingRow(key === "rolling" ? "5 小时额度" : key === "weekly" ? "周额度" : "月额度", value.percent, 100, Number(value.percent) > 0 ? value.resetsAt : null, "%"));
  if (kind === "codex") {
    const windows = raw.rate_limit ?? {};
    const rows = [windows.primary_window, windows.secondary_window].filter(Boolean).map(w =>
      remainingRow(w.limit_window_seconds === 18000 ? "5 小时额度" : w.limit_window_seconds === 604800 ? "7 天额度" : `${Math.round(w.limit_window_seconds / 3600)} 小时额度`, w.used_percent, 100, Number(w.used_percent) > 0 ? w.reset_at : null, "%"));
    const balance = number(raw.credits?.balance);
    if (raw.credits?.has_credits && !raw.credits?.unlimited && balance !== undefined) rows.push({ label: "Codex Credits", remaining: balance, unit: "Credits" });
    return rows;
  }
  if (kind === "claude") return Object.entries(raw).filter(([key, val]: any) => key.startsWith("five_hour") || key.startsWith("seven_day"))
    .filter(([, val]: any) => val && number(val.utilization) !== undefined)
    .map(([key, val]: any) => remainingRow(key.replace("five_hour", "5 小时").replace("seven_day", "7 天").replaceAll("_", " "), val.utilization, 100, Number(val.utilization) > 0 ? val.resets_at : null, "%"));
  if (kind === "kimi") {
    const rows = (raw.limits ?? []).filter((v: any) => v.detail).map((v: any) => remainingRow("短周期额度", Number(v.detail.limit) - Number(v.detail.remaining), v.detail.limit, v.detail.resetTime, "次"));
    if (raw.usage) rows.push(remainingRow("总额度", Number(raw.usage.limit) - Number(raw.usage.remaining), raw.usage.limit, raw.usage.resetTime, "次"));
    return rows;
  }
  if (kind === "zhipu") {
    if (raw.success === false) throw new Error("供应商未返回有效套餐");
    return (raw.data?.limits ?? []).map((v: any) => remainingRow(v.type === "TOKENS_LIMIT" ? "Token 套餐" : "工具调用", v.percentage, 100, v.nextResetTime, "%"));
  }
  if (kind === "minimax") {
    if (raw.base_resp?.status_code) throw new Error("供应商未返回有效套餐");
    return (raw.model_remains ?? []).map((v: any) => remainingRow(v.model_name ?? "MiniMax", Number(v.current_interval_total_count) - Number(v.current_interval_usage_count), v.current_interval_total_count, v.end_time, "次"));
  }
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((v: any) => {
    if (v.isValid === false) throw new Error("余额查询返回账号不可用，请在 cc-switch 中检查");
    const row = remainingRow(String(v.planName ?? "账户余额").slice(0, 100), v.used, v.total, v.resetsAt, typeof v.unit === "string" ? v.unit.slice(0, 20) : undefined);
    const remaining = number(v.remaining);
    if (remaining !== undefined) row.remaining = remaining;
    return row;
  });
}
