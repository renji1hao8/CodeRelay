import type { FastifyInstance } from "fastify";
import { accounts } from "../accounts/service.ts";
import { httpError } from "../http.ts";
import { config } from "../config.ts";
export async function accountsRoutes(app: FastifyInstance) {
  app.get("/api/accounts", async req => {
    if (!config.features.accounts) return { providers: [], spending: { available: false }, notice: "额度集成未启用，可在电脑配置中开启" };
    const { refresh } = req.query as { refresh?: string };
    try { return await accounts(refresh === "1"); }
    catch { throw httpError(503, "无法读取 cc-switch 数据库，请确认已安装并运行 cc-switch"); }
  });
}
