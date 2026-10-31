import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { AccountsResponse, ProviderAccount } from "@remote-cc/shared";
import { parseQuota } from "./quota.ts";
import "../network.ts";

const dbPath = () => process.env.REMOTE_CC_CCSWITCH_DB || path.join(homedir(), ".cc-switch/cc-switch.db");
const cache = new Map<string, ProviderAccount>();
let flight: Promise<AccountsResponse> | null = null;
const parse = (s: string) => { try { return JSON.parse(s); } catch { return {}; } };
async function getJson(url: string, headers: Record<string, string>, init: RequestInit = {}) {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("额度接口必须使用 HTTPS");
  let response: Response;
  try { response = await fetch(target, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error("额度接口连接失败或超时；保留上次快照"); }
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "凭据失效，请在电脑上重新登录或检查 cc-switch" : `额度接口 HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("额度响应为空");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("额度响应过大"); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("额度接口响应格式不正确"); }
}
function evaluate(code: string, response?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./script-worker.mjs", import.meta.url), { workerData: { code, extract: response !== undefined, response: JSON.stringify(response) }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
    let settled = false;
    const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error("cc-switch 查询脚本执行超时")), 1500);
    worker.on("message", m => m.ok ? finish(undefined, m.value) : finish(new Error("cc-switch 查询脚本格式不兼容")));
    worker.on("error", () => finish(new Error("额度脚本执行失败")));
    worker.on("exit", () => { if (!settled) finish(new Error("额度脚本提前结束")); });
  });
}
async function queryProvider(row: any): Promise<ProviderAccount> {
  const key = `${row.app_type}:${row.id}`;
  const old = cache.get(key);
  const output: ProviderAccount = { id: row.id, app: row.app_type, name: row.name, current: !!row.is_current, rows: old?.rows ?? [], fetchedAt: old?.fetchedAt ?? null, stale: true };
  const config = parse(row.settings_config), script = parse(row.meta).usage_script;
  const env = config.env ?? {};
  const baseUrl = script?.baseUrl || env.ANTHROPIC_BASE_URL || /base_url\s*=\s*"([^"]+)"/.exec(config.config ?? "")?.[1] || "";
  const apiKey = script?.apiKey || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || config.auth?.OPENAI_API_KEY || "";
  try {
    let kind = "custom", raw: any;
    if (script?.enabled && script.code?.trim()) {
      const variables: Record<string, string> = { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, accessToken: script.accessToken ?? "", userId: script.userId ?? "" };
      const code = script.code.replace(/\{\{(apiKey|baseUrl|accessToken|userId)\}\}/g, (_: string, name: string) => JSON.stringify(variables[name]).slice(1, -1));
      const request = await evaluate(code);
      if (!baseUrl || new URL(request.url).origin !== new URL(baseUrl).origin) throw new Error("脚本查询地址与配置的供应商不一致，请在 cc-switch 检查 Base URL");
      if (!['GET', 'POST'].includes((request.method ?? 'GET').toUpperCase())) throw new Error("额度脚本只允许查询请求");
      raw = await getJson(request.url, request.headers ?? {}, { method: request.method ?? "GET", ...(request.body ? { body: typeof request.body === "string" ? request.body : JSON.stringify(request.body) } : {}) });
      raw = await evaluate(code, raw);
    } else if (script?.enabled && script.templateType === "token_plan") {
      kind = script.codingPlanProvider;
      if (!apiKey) throw new Error("cc-switch 中未配置供应商凭据");
      let url: string;
      if (kind === "kimi") url = "https://api.kimi.com/coding/v1/usages";
      else if (kind === "opencode_go") url = "https://opencode.ai/zen/go/v1/usage";
      else if (kind === "zhipu") url = baseUrl.includes("api.z.ai") ? "https://api.z.ai/api/monitor/usage/quota/limit" : "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
      else if (kind === "minimax") url = `https://${baseUrl.includes("api.minimax.io") ? "api.minimax.io" : "api.minimaxi.com"}/v1/api/openplatform/coding_plan/remains`;
      else throw new Error("此内置套餐尚未适配；可在 cc-switch 改用自定义余额查询脚本");
      raw = await getJson(url, { Authorization: kind === "zhipu" ? apiKey : `Bearer ${apiKey}`, Accept: "application/json" });
    } else if (row.app_type === "codex" && (!apiKey || row.category === "official")) {
      const auth = parse(await readFile(path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json"), "utf8"));
      if (!auth.tokens?.access_token) throw new Error("没有已登录的 Codex 订阅账号");
      kind = "codex";
      raw = await getJson("https://chatgpt.com/backend-api/wham/usage", { Authorization: `Bearer ${auth.tokens.access_token}`, "User-Agent": "codex-cli", ...(auth.tokens.account_id ? { "ChatGPT-Account-Id": auth.tokens.account_id } : {}) });
    } else if (script?.enabled && script.templateType === "official_subscription" && row.app_type.startsWith("claude")) {
      const auth = parse(await readFile(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), ".credentials.json"), "utf8"));
      const token = (auth.claudeAiOauth ?? auth["claude.ai_oauth"])?.accessToken;
      if (!token) throw new Error("没有已登录的 Claude 订阅账号");
      kind = "claude";
      raw = await getJson("https://api.anthropic.com/api/oauth/usage", { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" });
    } else throw new Error("请在 cc-switch 为此供应商启用额度查询");
    const rows = parseQuota(kind, raw);
    if (!rows.length) throw new Error("供应商未返回可用额度，未将未知额度显示为 0");
    const value = { ...output, rows, fetchedAt: new Date().toISOString(), stale: false };
    cache.set(key, value); return value;
  } catch (error) {
    // Never forward upstream bodies, credentials, config or raw script errors.
    const message = error instanceof Error && /^(额度|凭据|脚本|cc-switch|供应商|此内置|没有已登录|请在|未找到)/.test(error.message) ? error.message : "查询失败，请在 cc-switch 中检查配置";
    return { ...output, error: message };
  }
}
export function spendingOf(db: DatabaseSync, now = Date.now(), fixedOffsetMinutes?: number): AccountsResponse["spending"] {
  const explicit = fixedOffsetMinutes ?? (process.env.REMOTE_CC_BILLING_UTC_OFFSET_MINUTES ? Number(process.env.REMOTE_CC_BILLING_UTC_OFFSET_MINUTES) : undefined);
  let today: number, month: number;
  if (explicit !== undefined) {
    if (!Number.isFinite(explicit) || explicit < -840 || explicit > 840) throw new Error("Invalid billing timezone offset");
    const local = new Date(now + explicit * 60000);
    today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / 1000 - explicit * 60;
    month = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) / 1000 - explicit * 60;
  } else {
    const local = new Date(now);
    today = new Date(local.getFullYear(), local.getMonth(), local.getDate()).getTime() / 1000;
    month = new Date(local.getFullYear(), local.getMonth(), 1).getTime() / 1000;
  }
  const aggregate = db.prepare(`SELECT COALESCE(SUM(CASE WHEN created_at>=? THEN CAST(total_cost_usd AS REAL) ELSE 0 END),0) todayUsd,
    COALESCE(SUM(CAST(total_cost_usd AS REAL)),0) monthUsd,
    COALESCE(SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END),0) requests,
    COALESCE(SUM(CASE WHEN created_at>=? THEN input_tokens+output_tokens+cache_read_tokens+cache_creation_tokens ELSE 0 END),0) tokens
    FROM proxy_request_logs WHERE created_at>=?`).get(today, today, today, month) as any;
  const byProvider = db.prepare(`SELECT COALESCE(p.name,l.provider_id) name,l.app_type app,SUM(CAST(l.total_cost_usd AS REAL)) costUsd,COUNT(*) requests
    FROM proxy_request_logs l LEFT JOIN providers p ON p.id=l.provider_id AND p.app_type=l.app_type
    WHERE l.created_at>=? GROUP BY l.provider_id,l.app_type ORDER BY costUsd DESC LIMIT 20`).all(today) as any[];
  return { ...aggregate, byProvider, available: true };
}
export function accounts(refresh = false): Promise<AccountsResponse> {
  return flight ??= (async () => {
    const db = new DatabaseSync(dbPath(), { readOnly: true });
    let rows: any[], spending: AccountsResponse["spending"];
    try {
      rows = db.prepare("SELECT id,app_type,name,settings_config,meta,is_current,category FROM providers WHERE is_current=1 ORDER BY app_type").all();
      try { spending = spendingOf(db); }
      catch { spending = { todayUsd: 0, monthUsd: 0, requests: 0, tokens: 0, byProvider: [], available: false }; }
    } finally { db.close(); }
    const providers = await Promise.all(rows.map(row => {
      const old = cache.get(`${row.app_type}:${row.id}`);
      return !refresh && old && Date.now() - Date.parse(old.fetchedAt!) < 60000 ? old : queryProvider(row);
    }));
    return { providers, spending, fetchedAt: new Date().toISOString() };
  })().finally(() => { flight = null; });
}
