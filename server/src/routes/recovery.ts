import type { FastifyInstance } from "fastify";
import type { RecoveryRestartResponse } from "@remote-cc/shared";
import { recordAudit } from "../db.ts";
import { deviceFromRequest } from "../auth.ts";
import { buildDiagnostics } from "../diagnostics.ts";
import { httpError } from "../http.ts";
import {
  RESTART_DELAY_SEC,
  launchRestart,
  restartScriptExists,
  restartScriptPath,
} from "../restart.ts";

/**
 * 远程恢复 —— 手机在后端出问题时能做的事。
 *
 * ## 为什么需要它
 *
 * 工作场景是**人不在电脑前**,而后端跑在电脑上。以前后端一出问题,手机这侧就只有
 * 一条"连不上":看不到原因,也做不了任何动作。这两条路由把那两个缺口补上 ——
 * **导出诊断**(把电脑上那几份日志带到手机上)与**重启后端**(不用等人回去按)。
 *
 * ## 两条都要设备 token
 *
 * `index.ts` 的全局 onRequest 守卫自动管这件事 —— 它们**不在** PUBLIC_PATHS 里,
 * 这是故意的:一条能重启后端的接口,是这台机器上权限最重的东西之一。
 *
 * ## ⚠️ 后端进程**整个**不在时,这两条也够不着
 *
 * 那时候手机连的是一条死隧道。那种情况由救援进程顶上(`server/src/rescue.ts`)——
 * 它实现**同样的路径**,所以手机端不需要知道自己在跟谁说话。
 */
export async function recoveryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/recovery/diagnostics", async (req, reply) => {
    recordAudit(deviceFromRequest(req)?.id ?? null, "recovery.diagnostics", null, "ok");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("content-disposition", `attachment; filename="remotecc-diagnostics-${stamp}.txt"`);
    return reply.send(await buildDiagnostics());
  });

  app.post("/api/recovery/restart", async (req, reply) => {
    if (!restartScriptExists()) {
      // 说清楚是哪条路径找不到 —— 否则表现是"点了重启没反应",而人只会怀疑网络
      throw httpError(500, `找不到重启脚本:${restartScriptPath()}`);
    }

    recordAudit(
      deviceFromRequest(req)?.id ?? null,
      "recovery.restart",
      `延迟 ${RESTART_DELAY_SEC} 秒`,
      "ok",
    );

    // ⚠️ 顺序要紧:先把响应交给 Fastify,再动手。这个动作会把后端连同发起它的
    // 进程一起收掉(手机那条会话流就是后端的 claude 子进程)—— 反过来的话,这个包
    // 永远回不到手机上,表现是"点了没反应"而其实重启已经发生了(同坑 42 那一类)。
    launchRestart((err) => req.log.error({ err }, "拉起重启脚本失败"));

    const body: RecoveryRestartResponse = { ok: true, delaySec: RESTART_DELAY_SEC };
    return reply.code(202).send(body);
  });
}
