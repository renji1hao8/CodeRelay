import type { FastifyInstance } from "fastify";
import type { ClientFrame, PermissionDecision, ServerFrame } from "@remote-cc/shared";
import { HttpError, httpError } from "../http.ts";
import { armLiveness } from "../ws-liveness.ts";
import { listArtifacts, readArtifact } from "../codex/artifacts.ts";
import {
  attachmentsFrom,
  currentState,
  ensureWired,
  interruptTurn,
  listThreads,
  readThread,
  renameThread,
  respondApproval,
  setThreadArchived,
  snapshotFor,
  startThread,
  startTurn,
  subscribe,
} from "../codex/threads.ts";

/**
 * Codex 会话的路由 —— 列表、详情、以及那条 WebSocket。
 *
 * ## 它和 Claude 那条(`routes/stream.ts`)是两条独立的通道
 *
 * 不复用的理由不是"懒得动",而是**机制本来就不同**:Claude 那条要维护帧日志与水位
 * (因为它的历史在 jsonl、实时流是另一条路),而 Codex 的历史**随时能重读** ——
 * 接上时读一遍发过去就行,断线重连也是重读,**不需要水位**。
 *
 * 帧的**词汇**是共用的(assistant_delta / assistant_message / state / result /
 * permission_request),所以 App 那边连审批卡都能沿用现成的。
 *
 * ## 全部要设备 token
 *
 * 不在 `PUBLIC_PATHS` 里 —— 这几条能读会话说的话、还能批准 Codex 的命令。
 */

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function codexThreadRoutes(app: FastifyInstance): Promise<void> {
  // ⚠️ 在**注册时**就挂上,而不是等第一次列表调用 —— 审批是 Codex 主动问过来的,
  // 那时候可能还一次列表都没拉过。晚挂一次就少接一张卡。
  ensureWired();

  app.get("/api/codex/threads", async (req) => {
    const { cursor, q, archived, limit } = req.query as {
      cursor?: string;
      q?: string;
      archived?: string;
      limit?: string;
    };
    try {
      return await listThreads({
        cursor: cursor ?? null,
        q: q ?? null,
        // 与 Claude 那边同一条口径:`=== "1"` 才算要归档那份,**不是**布尔解析
        archived: archived === "1",
        limit: limit ?? null,
      });
    } catch (err) {
      // 说人话:没装 CLI / 起不来 / 超时,都在这句里(照额度那条的做法)
      throw httpError(503, `读不到 Codex 会话:${msg(err)}`);
    }
  });

  app.post("/api/codex/threads/:id/name", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: unknown };
    // ⚠️ 空串是**合法**的 —— 那是"抹掉自定义名",不是"没填"
    if (typeof body?.name !== "string") throw httpError(400, "需要 name(字符串)");
    try {
      await renameThread(id, body.name);
      return { ok: true };
    } catch (err) {
      throw httpError(503, `改名失败:${msg(err)}`);
    }
  });

  app.post("/api/codex/threads/:id/archive", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { archived?: unknown };
    if (typeof body?.archived !== "boolean") throw httpError(400, "需要 archived(布尔)");
    try {
      await setThreadArchived(id, body.archived);
      return { ok: true };
    } catch (err) {
      // ⚠️ 用 409 而不是 503:常见的那条失败是"这条会话正开在 Codex 桌面端",
      // 那**不是**后端坏了 —— 报 503 会让人去重启后端(见 `humanizeCodexError`)
      throw httpError(409, `归档失败:${msg(err)}`);
    }
  });

  app.get("/api/codex/threads/:id", async (req) => {
    const { id } = req.params as { id: string };
    // 「加载更早」的游标。原样转给 Codex —— 它是不透明的,我们只负责传回去
    const { before } = req.query as { before?: string };
    try {
      return await readThread(id, typeof before === "string" && before ? before : null);
    } catch (err) {
      throw httpError(503, `读不到这条 Codex 会话:${msg(err)}`);
    }
  });

  /**
   * 这条会话动过哪些文件。
   *
   * ⚠️ **与 Claude 那条 `/api/artifacts` 是两条数据来源**(那边扫 jsonl,这边翻
   * `fileChange` item)—— 见 `codex/artifacts.ts` 的文件头。
   */
  app.get("/api/codex/threads/:id/artifacts", async (req) => {
    const { id } = req.params as { id: string };
    try {
      return await listArtifacts(id);
    } catch (err) {
      throw httpError(503, `读不到这条会话的产物:${msg(err)}`);
    }
  });

  app.get("/api/codex/threads/:id/artifacts/:aid", async (req) => {
    const { id, aid } = req.params as { id: string; aid: string };
    try {
      const detail = await readArtifact(id, aid);
      // 找不到就 404 而不是给个空壳 —— 空壳会让界面显示一张"什么都没有"的卡片,
      // 而真正的原因是"这个 id 对不上"(多半是会话又改了,列表已经旧了)
      if (!detail) throw httpError(404, "这个产物不在列表里了(会话的改动可能变了),回去刷新一下");
      return detail;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw httpError(503, `读不到这个产物:${msg(err)}`);
    }
  });

  app.post("/api/codex/threads", async (req, reply) => {
    const body = req.body as { cwd?: unknown; text?: unknown };
    const cwd = typeof body?.cwd === "string" && body.cwd ? body.cwd : null;
    if (!cwd) throw httpError(400, "需要 cwd");
    const text = typeof body?.text === "string" ? body.text : null;
    try {
      const id = await startThread(cwd, text);
      return reply.code(201).send({ id });
    } catch (err) {
      throw httpError(503, `起不了 Codex 会话:${msg(err)}`);
    }
  });

  app.get("/api/codex/threads/:id/stream", { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };

    const send = (frame: ServerFrame) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(frame));
    };

    const release = subscribe(id, send);

    // 接入:状态真值 + 未决审批(补发)。
    // ⚠️ **不发历史** —— 历史由 App 用 `GET /api/codex/threads/:id` 拉。分开的理由:
    // 历史可能很长,而这条流是长连接;塞在一起会让"接上"这件事的成败依赖于历史的大小。
    for (const frame of snapshotFor(id)) send(frame);

    // 心跳照 Claude 那条(15 秒)。用**真值**而不是编一个 busy:false ——
    // 后者会让界面在正在跑的时候每隔 15 秒闪一下空闲。
    const heartbeat = setInterval(() => send(currentState(id)), 15_000);

    /**
     * **探活** —— 与 Claude 那条流**共用同一份实现**(`ws-liveness.ts`)。
     *
     * ⚠️ 它决定"有没有人在看"这件事准不准,而那正是**通知要不要发**的判据:
     * 手机切后台时 socket 是悄悄烂掉的(收不到 FIN、也没人往里写),烂掉的订阅者
     * 会让它判成"有人在看",于是**该通知的时候反而不通知** —— 比多弹一下糟得多。
     *
     * 顺带:reaper 与回放水位也都按"有没有订阅者"走,同样靠它才准。
     */
    const stopLiveness = armLiveness(socket);

    socket.on("message", (raw: Buffer | string) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as ClientFrame;
      } catch {
        return; // 坏帧直接丢 —— 不值得为它断连
      }

      switch (frame?.t) {
        case "user_message": {
          const text = typeof frame.text === "string" ? frame.text : "";
          // ⚠️ 判据是"有没有内容",不是"有没有文字" —— 只发一张图不打字是合法的
          // (`codexAttachments` 里的路径是 App 先传到 `/api/attach` 拿到的)
          const attachments = attachmentsFrom(frame.codexAttachments);
          if (!text.trim() && attachments.length === 0) return;
          startTurn(id, text, attachments).catch((err) =>
            send({ t: "error", message: `发不出去:${msg(err)}`, recoverable: true }),
          );
          return;
        }

        case "interrupt":
          interruptTurn(id).catch((err) => send({ t: "error", message: `打断失败:${msg(err)}`, recoverable: true }));
          return;

        case "permission_response": {
          const reqId = typeof frame.reqId === "string" ? frame.reqId : "";
          const decision: PermissionDecision = frame.decision === "allow" || frame.decision === "always" ? frame.decision : "deny";
          if (!respondApproval(reqId, decision)) {
            // 常见原因是卡片已经超时了(30 分钟)。说清楚,免得让人以为点了没用。
            send({ t: "error", message: "这条审批已经失效(多半是超时了)", recoverable: true });
          }
          return;
        }

        default:
          // Codex 这边没有权限模式、没有提权、没有斜杠命令 —— 其余上行帧一律不接。
          // 静默丢掉而不是报错:老版本 App 可能仍会发 `set_mode` 之类。
          return;
      }
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      stopLiveness();
      release();
    });
  });
}
