import type { AppReleaseResponse } from "./shared";

/**
 * App 自更新:版本比较与「要不要提示」的判据。
 *
 * ⚠️ **纯函数、不 import React/expo** —— 与 `messageMerge.ts` / `billing.ts` 同一个理由:
 * 能在裸 Node 里跑用例(`scripts/check-app-update.mjs`),退出码即结论。
 *
 * 判据只有一条:**`versionCode` 是整数,服务端严格大于本地才提示**。
 *
 * ⚠️ 别改成比 `versionName` 字符串 —— `"0.10.0" < "0.9.0"` 是按字典序成立的,
 * 那样升级到 0.10 之后手机反而会认为线上那个是旧版本,从此再也收不到更新。
 *
 * 相等 = 同一个包(重发过),更小 = 想降级。两种都静默。
 */

export type UpdateDecision =
  /** 已经是最新的(或服务端更旧) —— 什么都不用说 */
  | { kind: "latest" }
  /** 服务端或本机的版本号不正常 —— 说出来比默默提示更新有用 */
  | { kind: "invalid"; reason: string }
  /** 有更新的版本可用 */
  | { kind: "offer"; release: AppReleaseResponse };

export function decideUpdate(localCode: number, raw: unknown): UpdateDecision {
  if (typeof raw !== "object" || raw === null) {
    return { kind: "invalid", reason: "服务端回的不是一个版本对象" };
  }
  const r = raw as Partial<AppReleaseResponse>;
  const remote = r.versionCode;
  if (typeof remote !== "number" || !Number.isInteger(remote) || remote < 1) {
    return {
      kind: "invalid",
      reason: `服务端给的 versionCode 不是正整数:${JSON.stringify(remote)}`,
    };
  }

  // 本地读到 0 / NaN,说明这个包没把版本号正确带进去(生成 `src/version.ts` 那步断了)。
  // 那不是"有新版本",是构建出了问题 —— 按 invalid 报出来,否则会变成"每次都提示更新"。
  if (!Number.isInteger(localCode) || localCode < 1) {
    return { kind: "invalid", reason: `本机的 versionCode 不正常:${JSON.stringify(localCode)}` };
  }

  if (remote <= localCode) return { kind: "latest" };

  return {
    kind: "offer",
    release: {
      versionCode: remote,
      versionName: typeof r.versionName === "string" ? r.versionName : "",
      sha256: typeof r.sha256 === "string" ? r.sha256 : "",
      sizeBytes: typeof r.sizeBytes === "number" && Number.isFinite(r.sizeBytes) ? r.sizeBytes : 0,
      notes: typeof r.notes === "string" && r.notes ? r.notes : null,
      publishedAt: typeof r.publishedAt === "string" ? r.publishedAt : "",
    },
  };
}
