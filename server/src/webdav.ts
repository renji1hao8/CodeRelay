import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

/**
 * 只读 WebDAV 的凭据。
 *
 * 为什么单开一套而不是复用 App 的 token:连上来的是**第三方文件管理器**,
 * 它们只会发 HTTP Basic(用户名 + 密码),不会发 Bearer。而且分开之后,
 * 想收回手机上的挂载权限不必动 App 的配对。
 *
 * 用户名固定成 remotecc —— WebDAV 客户端都要求填一个,让人再记一个用户名没意义。
 */
export const DAV_USER = "remotecc";

const PASSWORD_FILE = path.join(config.dataDir, "webdav-password.txt");

let cached: string | null = null;

/** 首次调用时生成并落盘。和配对密码一样,使用者从不需要记住它 —— 用 `show-webdav-info.mjs` 读。 */
export function davPassword(): string {
  if (cached) return cached;
  try {
    const existing = fs.readFileSync(PASSWORD_FILE, "utf8").trim();
    if (existing) {
      cached = existing;
      return existing;
    }
  } catch {
    /* 还没有,下面生成 */
  }
  const generated = crypto.randomBytes(18).toString("base64url");
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(PASSWORD_FILE, generated + "\n", { mode: 0o600 });
  cached = generated;
  return generated;
}

export function davPasswordPath(): string {
  return PASSWORD_FILE;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * 校验 Basic 凭据。认不过就返回 false,调用方回 401 并带上 WWW-Authenticate。
 *
 * 注意这里**不看来源地址** —— 和配对码那个坑同一个道理:隧道下 nginx 从 127.0.0.1
 * 转发,来源地址在这儿没有任何鉴别力。凭据是唯一的门槛。
 */
export function davAuthOk(header: string | undefined): boolean {
  if (!header) return false;
  const m = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!m?.[1]) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;

  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  // 两个都比较(不短路) —— 短路会泄漏"用户名对不对"这个信息
  return constantTimeEqual(user, DAV_USER) && constantTimeEqual(pass, davPassword());
}
