import { ApiError } from "./api";

/**
 * 跨页面共用的小工具。
 *
 * 这里的东西都有一个共同点:**同一个语义原先在多处各写了一遍**。
 * 收进来的标准是"出现两次以上,且写错一处不会有任何提示"。
 */

/** 后端默认端口。App.tsx 与 PairScreen 原先各写了一遍字面量 8787 */
export const DEFAULT_SERVER_PORT = 8787;

/**
 * 把任意异常转成能给用户看的一行字。
 *
 * ApiError 的 message 是后端写好的中文(比如"文件过大(1234 字节),请改用下载"),
 * 而其它异常的 String(err) 只是排障用的。所以优先取前者。
 * 这个三元原先在 22 处各写了一遍 —— 漏掉一处,那一处的报错就会变成
 * "TypeError: undefined is not an object" 这种给用户看的东西。
 */
export function errText(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

/** 从路径里取文件名。Windows 与 POSIX 两种分隔符都要认 */
export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * 给十六进制色加透明度后缀(RN 认 #RRGGBBAA)。
 *
 * 原来各处直接拼字符串 —— `color + "14"` 做图标底、`color + "66"` 做描边 ——
 * 同一套规则散在三处,改一处深浅就会不一致。这里把 alpha 写成 0~1 的浮点数,
 * 读代码时能直接看出"这是 8% 还是 40%"。
 */
export function withAlpha(hex: string, alpha: number): string {
  const clamped = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${clamped}`;
}

/** 从后端 URL 中取出主机与端口。 */
export function parseHostPort(url: string): { host: string; port: number } | null {
  const m = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(url.trim());
  if (!m?.[1]) return null;
  return { host: m[1], port: Number(m[2] ?? DEFAULT_SERVER_PORT) };
}
