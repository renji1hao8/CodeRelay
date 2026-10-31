import http from "node:http";
import path from "node:path";
import type { HealthResponse, RecoveryRestartResponse } from "@remote-cc/shared";
import { config } from "./config.ts";
import { deviceForToken } from "./auth.ts";
import { recordAudit } from "./db.ts";
import { buildDiagnostics, tail } from "./diagnostics.ts";
import { probePort } from "./probe.ts";
import {
  RESTART_DELAY_SEC,
  launchRestart,
  restartScriptExists,
  restartScriptPath,
} from "./restart.ts";
import { installCrashGuard } from "./crash-guard.ts";

// 救援进程是"后端没了之后唯一还接得住的一环" —— 它自己更不能因为一个野事件退出。
// 同一条理由见 crash-guard.ts 的文件头。
installCrashGuard("救援进程");

/**
 * 救援进程 —— **后端进程本身没在跑时,顶上来接手机的那一个**。
 *
 * ## 它为什么必须存在
 *
 * 主后端的两条恢复路由(`routes/recovery.ts`)救不了"后端进程整个不在了"这种情形:
 * 那时候手机连的是一条死隧道,nginx 回 502,而 nginx 后面什么都没在听。
 *
 * 所以这里是一个**独立的小进程**:绑在后端端口 +1 上,由看门狗保活。nginx 在
 * 后端 502/503/504 时会回退到它(`error_page … = @rescue`)—— 于是**手机端的地址
 * 一个字都不用改**,它拿到的仍然是一个 200/202,而不是一个 502。
 *
 * ## 两条设计上的硬约束
 *
 * 1. **实现主后端同样的路径**,不另起一套 `/api/rescue/*`。手机端因此不需要知道
 *    自己此刻在跟谁说话:`/api/health` 照读、`/api/recovery/restart` 照点。
 *    多一套路径就意味着手机端要多一套分支,而那种分支平时永远跑不到、出问题时才跑 ——
 *    正是最容易坏掉的那一类代码。
 * 2. **尽可能小**:原生 `node:http`,不引 Fastify、不装配任何路由表。
 *    它的存在意义是"主后端起不来时它还能起来",所以它自己越简单越好。
 *
 * ## ⚠️ 不在这里做的事
 *
 * 不含会话、不含文件、不含审批 —— 除了下面那三条,其余**一律回 503 并说清楚这是
 * 救援模式**。让手机看到"后端没在运行"这句人话,比让它对着一个 404 猜要好。
 *
 * 用法:`node src/rescue.ts`(端口 = 后端端口 + 1,可用 `REMOTE_CC_RESCUE_PORT` 覆盖)
 */

const PORT = Number(process.env.REMOTE_CC_RESCUE_PORT ?? config.port + 1);
const BOOT_LOG = path.join(config.dataDir, "logs", "boot.log");

/** 后端端口 +1 是约定;写出来是为了让日志里那句话能自查 */
console.log(`[rescue] 救援进程启动:127.0.0.1:${PORT}(后端是 ${config.port})`);
if (!restartScriptExists()) {
  console.warn(`[rescue] ⚠️ 找不到重启脚本,「重启后端」会失败:${restartScriptPath()}`);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** 从 `Authorization: Bearer …` 或 `?token=` 取凭据 —— 与主后端 `auth.ts` 同一套口径 */
function tokenOf(req: http.IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return url.searchParams.get("token");
}

async function buildRescueHealth(): Promise<HealthResponse> {
  const [backendPortUp, ccSwitch, mihomo] = await Promise.all([
    probePort(config.port),
    probePort(config.upstream.ccSwitchPort),
    probePort(config.upstream.mihomoPort),
  ]);

  return {
    version: config.version,
    upstream: { ccSwitch, mihomo },
    /**
     * ⚠️ 这是**救援进程自己的**运行时长,不是后端的 —— 后端没在跑,没有它的时长可报。
     * 必须填:手机端那一排 `health.xxx` 是无保护读法,缺字段会直接崩。
     */
    uptimeSec: Math.floor(process.uptime()),
    /**
     * ⚠️ 这个 0 是**"后端那侧看不到"**,不是"机器上一个 claude 都没有"。
     * 后端被强杀时它的子进程会成为孤儿留在机器上,而这一份数不出来(要数得去翻
     * 进程表,那件事又慢又容易出错)。救援模式下这个数字别当真。
     */
    sessions: { live: 0, busy: 0 },
    rescue: {
      reason: backendPortUp
        ? "后端没接住刚才那个请求,但它现在又在监听了 —— 多半是崩过一次、又被拉起来了"
        : "后端进程没在运行",
      bootLogTail: await tail(BOOT_LOG, 40),
      backendPortUp,
    },
  };
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const p = url.pathname;

    // `/api/health` 与主后端一样是**公开**的(不公开的话,手机连"后端活着没有"
    // 都问不到 —— 而那正是它最需要知道的事)。
    if (p === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, await buildRescueHealth());
    }

    const device = deviceForToken(tokenOf(req, url));
    if (!device) return sendJson(res, 401, { error: "unauthorized" });

    if (p === "/api/recovery/diagnostics" && req.method === "GET") {
      const text = await buildDiagnostics();
      recordAudit(device.id, "recovery.diagnostics", "rescue", "ok");
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(text),
        "content-disposition": `attachment; filename="remotecc-diagnostics.txt"`,
        "cache-control": "no-store",
      });
      return res.end(text);
    }

    if (p === "/api/recovery/restart" && req.method === "POST") {
      if (!restartScriptExists()) {
        return sendJson(res, 500, { error: `找不到重启脚本:${restartScriptPath()}` });
      }
      recordAudit(device.id, "recovery.restart", `救援模式,延迟 ${RESTART_DELAY_SEC} 秒`, "ok");
      // ⚠️ 这个动作会把主后端拉起来 —— 而救援进程自己**不归后端那棵树管**
      // (它是看门狗/计划任务起的),所以它不会被一起收掉。这正是它能救人的原因。
      launchRestart((err) => console.error("[rescue] 拉起重启脚本失败", err));
      const body: RecoveryRestartResponse = { ok: true, delaySec: RESTART_DELAY_SEC };
      return sendJson(res, 202, body);
    }

    // 其余一律 503 + 人话。**别回 404** —— 手机读的是 `body.error`,而
    // "这个路径不存在"对使用者毫无用处;"后端没在运行"才是他能行动的信息。
    return sendJson(res, 503, {
      error: "后端没在运行(现在是救援模式)。去设置页的「故障排查」重启它。",
    });
  })().catch((err) => {
    console.error("[rescue] 处理请求时出错", err);
    if (!res.headersSent) sendJson(res, 500, { error: `救援进程出错:${String(err)}` });
  });
});

// 绑 127.0.0.1 而不是 0.0.0.0:它只该由 frpc(本机)转发进来。
// 主后端绑 0.0.0.0 是为了局域网调试方便,而救援进程没这个需求 —— 它是一条
// **能重启后端**的口子,能少暴露一层是一层。
server.listen(PORT, "127.0.0.1");
