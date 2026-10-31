import type { FastifyInstance } from "fastify";
import type { DesktopProvider } from "@remote-cc/shared";
import { desktopList, desktopDetail, desktopSend, desktopOpen, initDeliveryLedger } from "../desktop/service.ts";
import { deviceFromRequest } from "../auth.ts";
import { httpError } from "../http.ts";
import { desktopControl, desktopAction, desktopTaskOutput } from "../desktop/control.ts";
import type { DesktopAction } from "@remote-cc/shared";
import { recordAudit } from "../db.ts";

function providerOf(value: string): DesktopProvider {
  if (value !== "claude" && value !== "codex") throw httpError(400, "会话来源无效");
  return value;
}
export async function desktopRoutes(app: FastifyInstance) {
  initDeliveryLedger();
  app.post("/api/desktop/:provider/sessions/:id/open", async req => {
    const { provider, id } = req.params as { provider: string; id: string };
    const selected = providerOf(provider), device = deviceFromRequest(req);
    if (!device) throw httpError(401, "设备未配对");
    const session = await desktopOpen(selected, id);
    recordAudit(device.id, "desktop.open", `${selected}:${id}`, "ok");
    return { session };
  });
  app.get("/api/desktop/:provider/sessions/:id/control", async req => {
    const { provider, id } = req.params as { provider: string; id: string };
    return desktopControl(providerOf(provider), id);
  });
  app.post("/api/desktop/:provider/sessions/:id/control", async req => {
    const { provider, id } = req.params as { provider: string; id: string };
    const body = req.body as any;
    const validId = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 200;
    if (!body || !(body.type === "interrupt" && validId(body.turnKey) || body.type === "stopTask" && validId(body.taskId) || body.type === "approval" && validId(body.requestId) && ["allow", "deny"].includes(body.decision))) throw httpError(400, "操作参数无效");
    const selected = providerOf(provider), device = deviceFromRequest(req);
    if (!device) throw httpError(401, "设备未配对");
    try {
      const result = await desktopAction(selected, id, body as DesktopAction);
      recordAudit(device.id, `desktop.${body.type}`, `${selected}:${id}`, "ok", result.status);
      return result;
    } catch (error) {
      recordAudit(device.id, `desktop.${body.type}`, `${selected}:${id}`, "error");
      throw error;
    }
  });
  app.get("/api/desktop/:provider/sessions/:id/tasks/:taskId/output", async req => {
    const { provider, id, taskId } = req.params as { provider: string; id: string; taskId: string };
    return desktopTaskOutput(providerOf(provider), id, taskId);
  });
  app.get("/api/desktop/:provider/sessions", async req => {
    const { provider } = req.params as { provider: string };
    const { cursor } = req.query as { cursor?: string };
    return desktopList(providerOf(provider), cursor);
  });
  app.get("/api/desktop/:provider/sessions/:id", async req => {
    const { provider, id } = req.params as { provider: string; id: string };
    const { cursor } = req.query as { cursor?: string };
    return desktopDetail(providerOf(provider), id, cursor);
  });
  app.post("/api/desktop/:provider/sessions/:id/messages", async (req, reply) => {
    const { provider, id } = req.params as { provider: string; id: string };
    const body = req.body as { text?: unknown; requestId?: unknown };
    if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 16000) throw httpError(400, "消息需为 1–16000 个字符");
    if (typeof body.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId)) throw httpError(400, "消息标识无效");
    const device = deviceFromRequest(req);
    if (!device) throw httpError(401, "设备未配对");
    const result = await desktopSend(providerOf(provider), id, body.text, body.requestId, device.id);
    return reply.code(202).send(result);
  });
}
