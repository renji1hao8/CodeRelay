import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { db, nowIso } from "./db.ts";

const PAIRING_TTL_MS = 5 * 60_000;

/**
 * 配对密码存放位置。
 *
 * 它是**机器对机器**的秘密:只有电脑上的 `scripts/show-pair-info.mjs` 需要它,
 * 手机端不需要(手机只调 /api/pair/claim)。所以使用者从不需要看见或输入它。
 */
const PAIR_PASSWORD_FILE = path.join(config.dataDir, "pair-password.txt");

let cachedPairPassword: string | null = null;

/**
 * 配对密码。首次调用时生成并落盘。
 *
 * ⚠️ **为什么必须有这个东西**
 *
 * 原来 /api/pair/start 只检查 `isLoopback(remoteAddress)`。这道防线是按 ZeroTier
 * 时代设计的 —— 那时电脑和手机是不同的 IP,环回 == 真的在本机。
 *
 * 上了隧道之后它**悄悄失效了**:nginx 终结 TLS 后从 127.0.0.1 转发,于是任何
 * 公网请求在后端眼里都是环回。实测确认过:从外网 `POST /api/pair/start` 能直接
 * 拿到配对码,再 claim 就换到设备 token —— 等于把整个后端(含整个 E 盘)交出去。
 *
 * 有了这道密码,公网上拿不到配对码,后面的 claim 也就无从下手。
 * 它把"互联网上任何人"收窄成"能读到电脑上这个文件的人"。
 */
export function pairPassword(): string {
  if (cachedPairPassword) return cachedPairPassword;
  try {
    const existing = fs.readFileSync(PAIR_PASSWORD_FILE, "utf8").trim();
    if (existing) {
      cachedPairPassword = existing;
      return existing;
    }
  } catch {
    /* 还没有,下面生成 */
  }
  const generated = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(PAIR_PASSWORD_FILE, generated + "\n", { mode: 0o600 });
  cachedPairPassword = generated;
  return generated;
}

export function pairPasswordPath(): string {
  return PAIR_PASSWORD_FILE;
}

export function pairPasswordMatches(given: unknown): boolean {
  if (typeof given !== "string" || !given) return false;
  const expected = pairPassword();
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // 先比长度再 timingSafeEqual:后者要求等长,否则会抛
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * claim 的失败计数。
 *
 * 光给 start 加密码还不够:配对码是 6 位十进制(1e6 种),而隧道有 200Mbps ——
 * 敞开来试的话几千次每秒,5 分钟窗口内是可能碰上的。
 *
 * 计数是**全局**的而不是按 IP:隧道下所有请求都来自 127.0.0.1,按 IP 计数毫无意义。
 * 代价是攻击者持续尝试会连带把正常配对锁住,但正常人配对只需要一次尝试,
 * 且窗口只有 5 分钟 —— 比敞开让人爆破划算得多。
 */
const CLAIM_WINDOW_MS = 5 * 60_000;
const CLAIM_MAX_FAILURES = 10;
let claimFailures: number[] = [];

export function claimAllowed(): boolean {
  const now = Date.now();
  claimFailures = claimFailures.filter((t) => now - t < CLAIM_WINDOW_MS);
  return claimFailures.length < CLAIM_MAX_FAILURES;
}

export function noteClaimFailure(): number {
  claimFailures.push(Date.now());
  return claimFailures.length;
}

interface Device {
  id: string;
  name: string;
  revoked: number;
}

let pairing: { code: string; expiresAt: number } | null = null;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function startPairing(): { code: string; expiresAt: string } {
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  pairing = { code, expiresAt };
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

export function pairingActive(): boolean {
  return pairing !== null && Date.now() < pairing.expiresAt;
}

/** 配对码一次性使用;返回的 token 只在这一次响应里明文出现过 */
export function claimPairing(code: string, deviceName: string): { token: string; deviceId: string } | null {
  if (!pairing || Date.now() > pairing.expiresAt || pairing.code !== code) return null;
  pairing = null;

  const token = crypto.randomBytes(32).toString("base64url");
  const deviceId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, revoked) VALUES (?, ?, ?, ?, ?, 0)",
  ).run(deviceId, deviceName.slice(0, 64), hashToken(token), nowIso(), nowIso());

  return { token, deviceId };
}

/**
 * 用 token 找一个没被吊销的设备。
 *
 * 抽出来是为了让**救援进程**(`rescue.ts`)复用同一份判据 —— 那个进程跑的是原生
 * `node:http`,手里没有 Fastify 的 request 对象。两处各写一遍哈希与查询的话,
 * 哪天改了哈希方式就会出现"主后端认、救援不认"这种最难查的不一致。
 */
export function deviceForToken(token: string | null): Device | null {
  if (!token) return null;
  const row = db
    .prepare("SELECT id, name, revoked FROM devices WHERE token_hash = ?")
    .get(hashToken(token)) as Device | undefined;
  if (!row || row.revoked) return null;

  db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(nowIso(), row.id);
  return row;
}

export function deviceFromRequest(req: FastifyRequest): Device | null {
  const header = req.headers.authorization;
  let token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    // WebSocket 无法自定义头时用查询参数传 token
    const q = req.query as { token?: string } | undefined;
    token = q?.token ?? null;
  }
  return deviceForToken(token);
}

export function listDevices() {
  return db
    .prepare("SELECT id, name, created_at, last_seen_at, revoked FROM devices ORDER BY created_at")
    .all() as { id: string; name: string; created_at: string; last_seen_at: string | null; revoked: number }[];
}

export function revokeDevice(id: string): boolean {
  const res = db.prepare("UPDATE devices SET revoked = 1 WHERE id = ?").run(id);
  return res.changes > 0;
}

/**
 * 请求是否来自本机(含 nginx 反代)。
 *
 * ⚠️ **这个判断不能当授权用**,只能当网络层的收窄。二者区别很关键:
 *
 * 上了隧道之后 nginx 从 127.0.0.1 转发,**公网请求在后端眼里同样是环回** ——
 * 所以"来源是环回"绝不等于"这个人可信"。曾经就是因为拿它当授权,
 * 导致公网任何人都能生成配对码(见 pairPassword 的说明)。
 *
 * 它现在唯一的作用是:后端绑的是 0.0.0.0,有了这一条,同一个局域网里的其他设备
 * 直连 8787 会被挡掉 —— 只有本机和反代进得来。真正的授权仍然是 token。
 */
export function isLoopbackRequest(addr: string | undefined): boolean {
  if (!addr) return false;
  const ip = addr.replace(/^::ffff:/, "");
  return ip === "::1" || ip.startsWith("127.");
}

/** 挂在路由上的前置校验:必须来自组网/环回,且持有有效 token */
export async function requireDevice(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.url.startsWith("/api/pair/")) return;
  const device = deviceFromRequest(req);
  if (!device) {
    await reply.code(401).send({ error: "unauthorized: 请先配对设备" });
  }
}
