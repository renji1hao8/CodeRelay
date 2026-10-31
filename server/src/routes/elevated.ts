import type { FastifyInstance } from "fastify";
import { elevated, type ElevatedDecision } from "../cc/elevated.ts";
import { recordAudit } from "../db.ts";
import { deviceFromRequest } from "../auth.ts";

/**
 * 提权执行器跟后端说话的两个口子。
 *
 * ## 为什么不要求 token
 *
 * 发起方是电脑上那个**以最高权限运行的脚本**(计划任务 `RemoteCC-Elevated`)——
 * 它手上没有设备 token,而且它已经比后端权限高了:给它发 token 是把授权关系写反。
 * 所以只有两道约束:
 *
 *   1. **只接受环回来源**(`index.ts` 的全局 `onRequest` 守卫;这条路挂在
 *      `PUBLIC_PATHS` 里,绕过的只是 requireDevice 那一层)
 *   2. **限流 + 字段截断**(见 `cc/elevated.ts`)
 *
 * ⚠️ 这看着松,其实是**故意的**:这条接口能造成的最大后果就是"手机上多一张等你点的
 * 红卡"。真正决定要不要动手的是手机上那一下 —— 所以它不需要凭据,反而**越简单越
 * 不容易出错**。
 *
 * ⚠️ 另外:本机任何进程都能调它(包括 agent 自己)。那不是漏洞,那是设计的一部分 ——
 * agent 想提权时**只能**走到这张红卡为止;想绕过得去冒充手机(见 `cc/elevated.ts`
 * 末尾那段安全边界)。
 */
export async function elevatedRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 提权脚本要动手了,先问人。
   *
   * ⚠️ 这个请求会**一直挂到手机上有人点**(或者 5 分钟超时)。脚本那头是同步等的。
   */
  app.post("/api/elevated/request", async (req) => {
    const body = req.body as {
      action?: unknown;
      title?: unknown;
      detail?: unknown;
      caller?: unknown;
      reason?: unknown;
    };

    const out = await elevated.request({
      action: body?.action,
      title: body?.title,
      detail: body?.detail,
      caller: body?.caller,
      reason: body?.reason,
    });

    recordAudit(
      null,
      "elevated.request",
      out.reqId || "(限流未受理)",
      out.decision === "approve" ? "ok" : "denied",
      `${typeof body?.action === "string" ? body.action : "?"}: ${out.note ?? ""}`,
    );
    return { reqId: out.reqId, decision: out.decision, note: out.note ?? null };
  });

  /**
   * 未决的提权请求。
   *
   * 手机每次接入会话流时由后端**主动补发**(见 routes/stream.ts),这条是给
   * "App 冷启动、还没接上任何会话流"那种情况兜底用的。
   */
  app.get("/api/elevated/pending", async () => elevated.listPending());

  /**
   * 手机上的决定。
   *
   * 正常路径走的是会话流那一帧 `elevated_response`(手机手上就开着 WebSocket),
   * 这条 HTTP 版留着是给排障用的:没有它,想验一条请求就得真去手机上点。
   */
  app.post("/api/elevated/respond", async (req, reply) => {
    const body = req.body as { reqId?: unknown; decision?: unknown };
    const reqId = typeof body?.reqId === "string" ? body.reqId : "";
    const decision: ElevatedDecision = body?.decision === "approve" ? "approve" : "deny";
    const result = elevated.respond(reqId, decision);
    if (result !== "ok") {
      return reply.code(result === "expired" ? 410 : 404).send({ error: result });
    }
    recordAudit(
      deviceFromRequest(req)?.id ?? null,
      "elevated.respond",
      reqId,
      decision === "approve" ? "ok" : "denied",
    );
    return { ok: true };
  });
}
