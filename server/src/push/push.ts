import { kvGet, kvSet } from "../db.ts";

export type PushProvider = "off" | "ntfy" | "webhook";

export interface PushConfig {
  provider: PushProvider;
  /** ntfy: 服务器根地址;webhook: 完整 URL 模板 */
  endpoint: string;
  /** ntfy 的 topic */
  topic: string;
  /** webhook 用 GET 还是 POST */
  method: "GET" | "POST";
  enabled: boolean;
}

const DEFAULTS: PushConfig = {
  provider: "off",
  endpoint: process.env.REMOTE_CC_PUSH_ENDPOINT ?? "https://ntfy.sh",
  topic: process.env.REMOTE_CC_PUSH_TOPIC ?? "",
  method: "POST",
  enabled: false,
};

export function pushConfig(): PushConfig {
  const raw = kvGet("push.config");
  if (!raw) return DEFAULTS;
  try {
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PushConfig>) };
  } catch {
    return DEFAULTS;
  }
}

export function setPushConfig(patch: Partial<PushConfig>): PushConfig {
  const next = { ...pushConfig(), ...patch };
  kvSet("push.config", JSON.stringify(next));
  return next;
}

function fill(template: string, title: string, body: string, url: string): string {
  return template
    .replaceAll("{title}", encodeURIComponent(title))
    .replaceAll("{body}", encodeURIComponent(body))
    .replaceAll("{url}", encodeURIComponent(url));
}

export interface PushResult {
  sent: boolean;
  reason?: string;
}

/**
 * 通知只带一句不含敏感内容的摘要 + 一个深链。真正的详情由 App 经组网回来拉,
 * 这样即使组网没连上,通知也能送达。
 */
export async function notify(
  title: string,
  body: string,
  clickUrl: string,
): Promise<PushResult> {
  const cfg = pushConfig();
  if (!cfg.enabled) return { sent: false, reason: "推送未启用" };
  if (!cfg.endpoint) return { sent: false, reason: "未配置推送地址" };

  try {
    if (cfg.provider === "ntfy") {
      if (!cfg.topic) return { sent: false, reason: "ntfy 未配置 topic" };
      const res = await fetch(cfg.endpoint.replace(/\/$/, ""), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic: cfg.topic,
          title,
          message: body,
          click: clickUrl,
          tags: ["robot"],
        }),
      });
      return { sent: res.ok, reason: res.ok ? undefined : `ntfy 返回 ${res.status}` };
    }

    if (cfg.provider === "webhook") {
      const url = fill(cfg.endpoint, title, body, clickUrl);
      const res = await fetch(url, { method: cfg.method });
      return { sent: res.ok, reason: res.ok ? undefined : `webhook 返回 ${res.status}` };
    }

    return { sent: false, reason: "未选择推送通道" };
  } catch (err) {
    // 出网可能受代理限制,记下来让用户能看到原因
    return { sent: false, reason: `推送失败: ${String(err)}` };
  }
}
