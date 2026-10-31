import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import type { HealthResponse, PairStartResponse } from "@remote-cc/shared";
import { config } from "./config.ts";
import {
  claimAllowed,
  claimPairing,
  isLoopbackRequest,
  listDevices,
  noteClaimFailure,
  pairPassword,
  pairPasswordMatches,
  pairPasswordPath,
  requireDevice,
  revokeDevice,
  startPairing,
} from "./auth.ts";
import { HttpError } from "./http.ts";
import { broadcastTransient, firstLiveCcId, getSession, listLive, onNotify, subscriberCount } from "./cc/registry.ts";
import { elevated } from "./cc/elevated.ts";
import { usageRoutes } from "./routes/usage.ts";
import { elevatedRoutes } from "./routes/elevated.ts";
import { appReleaseRoutes } from "./routes/app-release.ts";
import { recoveryRoutes } from "./routes/recovery.ts";
import { codexRoutes } from "./routes/codex.ts";
import { codexThreadRoutes } from "./routes/codex-threads.ts";
import { desktopRoutes } from "./routes/desktop.ts";
import { accountsRoutes } from "./routes/accounts.ts";
import { notify, pushConfig, setPushConfig } from "./push/push.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { streamRoutes } from "./routes/stream.ts";
import { shellRoutes } from "./routes/shell.ts";
import { terminalRoutes } from "./routes/terminal.ts";
import { closeTerminalForDevice, closeAllTerminals } from "./shell/terminal.ts";
import { stopAllJobs } from "./shell/jobs.ts";
import { reportPwsh } from "./shell/pwsh.ts";
import { eventRoutes } from "./routes/events.ts";
import { fsRoutes } from "./routes/fs.ts";
import { artifactRoutes } from "./routes/artifacts.ts";
import { davRoutes, PREFIX as DAV_PREFIX } from "./routes/dav.ts";
import { davPassword, davPasswordPath } from "./webdav.ts";
import { broadcastEvent } from "./events.ts";
import { probePort } from "./probe.ts";
import { installCrashGuard } from "./crash-guard.ts";
import { acceptsNetworkRequest } from "./network-access.ts";

/**
 * ⚠️ 装在所有 import **之后** —— 模块顶层的那些初始化(建表、`ensureMessageDedupe`)
 * 该失败就得失败,那种失败由 bootstrap 报成"后端 启动失败"才对。这里兜的是**跑起来之后**
 * 冒出来的野事件(比如某个 socket 没人管),见 crash-guard.ts 的文件头。
 */
installCrashGuard("后端");

const startedAt = Date.now();

/**
 * 上游探测结果缓存。
 *
 * 这个接口是手机顶部状态条的数据源,正常时 20 秒问一次,而链路一旦判定成"不通"
 * 就会 2 秒问一次 —— 每次都新开两个 TCP 探测太浪费,何况探测本身还有 800ms 超时,
 * 会把 health 的响应时间拖上去。App 冷启动时几个组件同时探,也能靠它合并掉。
 */
let probeCache: { at: number; ccSwitch: boolean; mihomo: boolean } | null = null;
let probeFlight: Promise<void> | null = null;
const PROBE_TTL_MS = 3_000;

async function buildHealth(): Promise<HealthResponse> {
  if (!probeCache || Date.now() - probeCache.at > PROBE_TTL_MS) {
    await (probeFlight ??= Promise.all([
      probePort(config.upstream.ccSwitchPort, "127.0.0.1", 350),
      probePort(config.upstream.mihomoPort, "127.0.0.1", 350),
    ]).then(([ccSwitch, mihomo]) => { probeCache = { at: Date.now(), ccSwitch, mihomo }; })
      .finally(() => { probeFlight = null; }));
  }
  const live = listLive();
  return {
    version: config.version,
    upstream: { ccSwitch: probeCache!.ccSwitch, mihomo: probeCache!.mihomo },
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    sessions: { live: live.length, busy: live.filter((s) => s.busy).length },
  };
}

const PUBLIC_PATHS = new Set([
  "/",
  "/api/health",
  "/api/pair/start",
  "/api/pair/claim",
  /**
   * ⚠️ 提权执行器**只能**走这一个口子,而且它是**故意**不要 token 的
   * (见 routes/elevated.ts 的说明):发起方是电脑上那个比后端权限还高的脚本,
   * 它没有设备 token;而这条接口能造成的最大后果只是"手机上多一张等你点的红卡"。
   *
   * ⚠️ 反过来,`/api/elevated/pending` 与 `/api/elevated/respond`(**回答**那两条)
   * **不在这里** —— 它们要设备 token。区别很重要:提问谁都能提,批不批只有手机说了算;
   * 把"批准"那条也放开,等于把闸门降成一行 curl。
   */
  "/api/elevated/request",
]);

/**
 * 只读 WebDAV 挂在 `/dav` 下,面向的是**第三方文件管理器** ——
 * 它们只会发 HTTP Basic,不会带 App 的 Bearer token。所以这一路必须放行出
 * requireDevice,由它自己用 davAuthOk 校验。见 routes/dav.ts。
 */
function isDavPath(p: string): boolean {
  return p === "/dav" || p.startsWith("/dav/");
}

const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 });

await app.register(websocket);
await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024 } });

// 默认仅环回监听；显式 LAN 模式允许其他设备访问普通路由。
// 网络来源不能代替授权：反向代理请求也来自环回，仍需设备 token 与配对密码。
app.addHook("onRequest", async (req, reply) => {
  const path = req.url.split("?")[0] ?? "";
  if (!acceptsNetworkRequest(isLoopbackRequest(req.socket.remoteAddress), path, config.listenHost)) {
    req.log.warn({ remote: req.socket.remoteAddress }, "拒绝非本机来源的请求");
    return reply.code(403).send({ error: "forbidden: not from loopback" });
  }
  if (PUBLIC_PATHS.has(path) || isDavPath(path)) return;
  await requireDevice(req, reply);
});

/**
 * 把**抛出来的** `httpError(...)` 序列化成 `{ error: "人话" }`。
 *
 * ⚠️ 不加这一条,那些错误的正文**到不了手机上**(2026-09-22 查上传文件名那个 bug 时发现的):
 * 路由里有两套报错写法 ——
 *
 *   · `reply.code(400).send({ error: "目标路径越界" })` —— 显式构造,App 读 `body.error`,对的;
 *   · `throw httpError(400, "目标路径越界")` —— 走 Fastify 的默认错误处理器,而它发的是
 *     `{ statusCode, error: "Bad Request", message: "目标路径越界" }` —— **`error` 那一栏是
 *     状态短语**。而 App 的 `describeApiError` 第一个读的就是 `body.error`。
 *
 * 于是同一句话,显式 `send` 的能看见,`throw` 的到手机上就只剩 "Bad Request" / "Forbidden"。
 * 那是一句查不下去的话 —— 使用者只知道"出错了",不知道错在哪。
 *
 * 所以统一成一种形状:`error` 那一栏永远是**给人看的那句话**。
 * 非 HttpError(真·意外)照样把消息带出去 —— 这是单人自用的工具,"内部错误"这四个字
 * 对他没有任何帮助,而且这条通道本来就只有持有设备 token 的手机进得来。细节同时进日志。
 */
app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  const status = err instanceof HttpError ? err.status : (err.statusCode ?? 500);
  const message = err.message || "请求失败";
  if (status >= 500) {
    req.log.error({ err, url: req.url }, "请求失败");
  }
  reply.code(status).send({ error: message });
});

app.get("/api/health", buildHealth);

app.post("/api/pair/start", async (req, reply) => {
  // ⚠️ 这里**不能**再依赖 isLoopback 当授权:隧道下 nginx 从 127.0.0.1 转发,
  // 于是任何公网请求的来源都是环回,那道判断对攻击者一样成立。
  // 改用只有电脑读得到的配对密码。详见 auth.ts 的 pairPassword()。
  const given = req.headers["x-remote-cc-pair-password"];
  if (!pairPasswordMatches(given)) {
    // 不回显密码文件的位置 —— 那是给攻击者的免费信息。位置记在日志里给自己看。
    req.log.warn({ remote: req.socket.remoteAddress }, "拒绝生成配对码:密码不正确或缺失");
    return reply.code(403).send({ error: "forbidden: 需要配对密码" });
  }
  const { code, expiresAt } = startPairing();
  const response: PairStartResponse = {
    code,
    expiresAt,
    publicUrl: config.publicUrl || null,
    port: config.port,
  };
  req.log.info({ code }, "已生成配对码");
  return response;
});

app.post("/api/pair/claim", async (req, reply) => {
  const { code, deviceName } = req.body as { code?: string; deviceName?: string };
  if (!code || !deviceName) {
    return reply.code(400).send({ error: "需要 code 与 deviceName" });
  }
  // 配对码只有 6 位十进制,敞开来试是能被爆破的 —— 见 auth.ts 的 claimAllowed()
  if (!claimAllowed()) {
    req.log.warn("配对尝试过于频繁,暂时拒绝");
    return reply.code(429).send({ error: "配对尝试过于频繁,请几分钟后再试" });
  }
  const result = claimPairing(code, deviceName);
  if (!result) {
    req.log.warn({ failures: noteClaimFailure() }, "配对码错误");
    return reply.code(400).send({ error: "配对码错误或已过期" });
  }
  req.log.info({ deviceId: result.deviceId, deviceName }, "设备已配对");
  return result;
});

app.get("/api/devices", async () => listDevices());

app.delete("/api/devices/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!revokeDevice(id)) return reply.code(404).send({ error: "设备不存在" });
  closeTerminalForDevice(id);
  return { ok: true };
});

app.get("/api/push/config", async () => {
  const cfg = pushConfig();
  return { ...cfg, topic: cfg.topic ? "已配置" : "" };
});

app.post("/api/push/config", async (req) => setPushConfig(req.body as Record<string, never>));

app.post("/api/push/test", async () => {
  const title = "远程cc 测试通知";
  const body = "如果你在手机上看到这条,推送通道是通的";
  const link = "remotecc://home";
  // 既走外部推送通道,也走 App 内的后台事件流 —— 这样点一次就能同时验两条路
  broadcastEvent({
    t: "notify",
    kind: "test",
    title,
    body,
    link,
    runId: null,
    ccSessionId: null,
    at: new Date().toISOString(),
  });
  return notify(title, body, link);
});

if (config.features.legacyCli) {
  await app.register(sessionRoutes);
  await app.register(streamRoutes);
  await app.register(shellRoutes);
  await app.register(usageRoutes);
  await app.register(codexRoutes);
  await app.register(codexThreadRoutes);
}
await app.register(terminalRoutes);
await app.register(eventRoutes);
await app.register(fsRoutes);
await app.register(artifactRoutes);
if (config.features.webdav) await app.register(davRoutes);
if (config.features.elevation) await app.register(elevatedRoutes);
await app.register(appReleaseRoutes);
await app.register(recoveryRoutes);
await app.register(desktopRoutes);
await app.register(accountsRoutes);

/**
 * 提权请求 → 手机上那张红卡。
 *
 * 它不属于任何一条会话(发起方是电脑上独立的那个脚本),所以**每条活着的会话流都推
 * 一份** —— 使用者此刻开着哪一屏都能立刻看到。谁先点算谁的,服务端只认第一次
 * (见 cc/elevated.ts 的 respond)。
 *
 * 除了卡本身,还要走**两条独立的通知通路**(和 onNotify 那边同一个道理):
 * 系统推送(可能压根没配)与 App 的常驻服务。这事不能靠"他正好在看手机"。
 */
elevated.setOnAsk((req) => {
  const sent = broadcastTransient({
    t: "elevated_request",
    reqId: req.reqId,
    action: req.action,
    title: req.title,
    detail: req.detail,
    caller: req.caller,
    reason: req.reason,
  });
  const ccId = firstLiveCcId();
  const link = ccId ? `remotecc://session/cc/${ccId}` : "remotecc://session";
  const headline = "有人要用管理员权限";
  void notify(headline, req.title, link);
  broadcastEvent({
    t: "notify",
    kind: "approval",
    title: headline,
    body: req.title,
    link,
    runId: null,
    ccSessionId: ccId,
    at: new Date().toISOString(),
  });
  console.log(
    `[提权] ${req.reqId.slice(0, 8)} ${req.action} → 推给 ${sent} 条会话流,等手机应答`,
  );
});

// 需要用户关注的事件 → 推送。通知正文不含敏感内容,只带一个深链。
// 深链优先用 CC 的 sessionId:runId 只活在内存里,后端一重启旧通知就点不开了
onNotify((runId, kind, text) => {
  const session = getSession(runId);
  if (!session) return;

  /**
   * ⚠️ **只有「任务完成」才按"没人看着"静音。**
   *
   * `done` 是**信息性**的 —— 你正盯着屏幕看它写完,不用再震一下(这就是原来
   * "人正看着也弹一条"的来源)。而 `approval` / `error` 是**要你动手**的:
   * 那一条宁可贵在多弹一下,不能漏。
   *
   * ⚠️ 判据准不准**取决于探活**(见 `ws-liveness.ts`):手机切后台时 socket 是悄悄
   * 烂掉的,烂连接会让这里判成"有人在看" → 该弹不弹。所以这一条与
   * `routes/stream.ts` 里的 `armLiveness` 是**成对的** —— 少了它就别开这个判断。
   */
  if (kind === "done" && subscriberCount(runId) > 0) return;

  const title = kind === "approval" ? "需要你批准" : kind === "error" ? "会话出错" : "任务完成";
  const target = session.ccSessionId ? `cc/${session.ccSessionId}` : `run/${runId}`;
  const link = `remotecc://session/${target}`;
  void notify(title, text, link);
  // 同一事件也推给 App 的后台常驻服务:外部推送可能压根没配,App 自己得能弹出来
  broadcastEvent({
    t: "notify",
    kind,
    title,
    body: text,
    link,
    runId,
    ccSessionId: session.ccSessionId,
    at: new Date().toISOString(),
  });
});

app.get("/", async (_req, reply) => {
  reply.type("text/html; charset=utf-8");
  return page(await buildHealth());
});

function page(h: HealthResponse): string {
  const dot = (ok: boolean) => `<span class="${ok ? "ok" : "bad"}">${ok ? "●" : "●"}</span>`;
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>远程cc</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; padding:24px; background:#0b0b0f; color:#e8e8ee;
         font:16px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif }
  h1 { font-size:20px; margin:0 0 4px }
  .sub { color:#8b8b9a; font-size:13px; margin-bottom:24px }
  .card { background:#15151c; border:1px solid #24242e; border-radius:12px; padding:16px; margin-bottom:12px }
  .row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #1e1e26 }
  .row:last-child { border-bottom:0 }
  .k { color:#8b8b9a }
  .ok { color:#3ddc84 } .bad { color:#ff5c5c }
  code { background:#1e1e26; padding:2px 6px; border-radius:5px; font-size:14px }
  .verdict { text-align:center; padding:20px; border-radius:12px; background:#10281c;
             border:1px solid #1d5638; color:#3ddc84; font-size:18px; font-weight:600; margin-bottom:20px }
</style></head><body>
<div class="verdict">手机已连通这台 PC ✓</div>
<h1>远程cc 后端</h1>
<div class="sub">${new Date().toLocaleString("zh-CN")} · 请用 App 配对后使用</div>

<div class="card">
  <div class="row"><span class="k">版本</span><code>${h.version}</code></div>
  <div class="row"><span class="k">运行时长</span><span>${h.uptimeSec}s</span></div>
  <div class="row"><span class="k">手机地址</span><code>${config.publicUrl || `http://127.0.0.1:${config.port}`}</code></div>
</div>

<div class="card">
  <div class="row"><span class="k">cc-switch :${config.upstream.ccSwitchPort}</span>${dot(h.upstream.ccSwitch)}</div>
  <div class="row"><span class="k">verge-mihomo :${config.upstream.mihomoPort}</span>${dot(h.upstream.mihomo)}</div>
</div>
</body></html>`;
}

// 启动时确保配对密码已生成并记下它在哪里。它从不需要人手输入 —— 手机只调 claim,
// 加密钥的 start 只有电脑上的 scripts/show-pair-info.mjs 会调。
pairPassword();
app.log.info({ file: pairPasswordPath() }, "配对密码已就位(公网上拿不到配对码)");

// 只读 WebDAV 的凭据。手机上的文件管理器要填它,用 `show-webdav-info.mjs` 读。
if (config.features.webdav) { davPassword();
app.log.info(
  { file: davPasswordPath(), mount: DAV_PREFIX },
  "只读 WebDAV 已就位(整机挂载,凭据见上面那个文件)",
);
}

// 用量扫描器:后台慢慢把 jsonl 里的 usage 收进库,给账单当原料。
// 它自己有游标(usage_scan)、和消息索引的 parsed_offset 各走各的,详见 history/usage.ts
// Legacy transcript/usage indexing runs in the history worker. It must not
// occupy the HTTP event loop while a phone is checking backend health.

// 命令框要跑 pwsh 7。**启动时探一次**并把结论打进日志 —— 探不到就大声报,
// 而不是让手机上每一条命令都莫名其妙地失败(见 shell/pwsh.ts)。
reportPwsh(app.log);

/**
 * 后端自己在退出时,把在跑的**命令**一起收干净。
 *
 * ⚠️ 走 `deploy/restart-backend.ps1` 重启那条路**不经过这里** —— 它是 `taskkill /F`,
 * 没有信号可接。不过那条路本来就会按父子关系把后端的后代全收掉
 * (见那个脚本的 `Stop-Descendants`),在跑的 `pwsh` 正是后端的后代,所以不会留孤儿。
 * 这里兜的是另一条路:前台 `node src/index.ts` 按 Ctrl+C。
 */
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopAllJobs();
    closeAllTerminals();
    // 留一点时间让 taskkill 发出去 —— 立刻 process.exit 会把它们掐在途中
    setTimeout(() => process.exit(0), 800);
  });
}

if (!config.publicUrl) {
  app.log.warn("未配置 REMOTE_CC_PUBLIC_URL —— 配对脚本不会告诉你手机该填哪个地址。");
}

try {
  await app.listen({ port: config.port, host: config.listenHost });
  app.log.info(
    { port: config.port, publicUrl: config.publicUrl || null, local: `http://127.0.0.1:${config.port}` },
    "远程cc 后端已就绪",
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
