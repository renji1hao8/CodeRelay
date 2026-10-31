import type { FastifyInstance } from "fastify";
import { onEvent, type ServerEvent } from "../events.ts";

/**
 * App 的后台常驻服务接这里。
 * 鉴权沿用全局前置钩子(token 走 ?token=,WebSocket 没法自定义头)。
 */
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/events", { websocket: true }, (socket, req) => {
    const send = (event: ServerEvent) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    };

    // 先发一帧 hello,让客户端能确认"通道真的通了",而不是在等一个可能永远不来的事件
    send({ t: "hello", at: new Date().toISOString() });

    const off = onEvent((event) => send(event));
    socket.on("close", off);
    socket.on("error", off);

    req.log.info("App 已接入全局事件流(后台通知)");
  });
}
