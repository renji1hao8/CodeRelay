import fs from "node:fs";
import fsp from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { ArtifactDetail, ArtifactKind, ArtifactSummary } from "@remote-cc/shared";
// 档位与 id 的口径**和 Codex 那条产物路共用一份** —— 见 artifact-kind.ts 的说明
import { artifactIdOf, kindOf } from "../artifact-kind.ts";
import { allRows, db, kvGet, kvSet, nowIso, oneRow, recordAudit } from "../db.ts";
import { deviceFromRequest } from "../auth.ts";
import { activeSessionForCcId, getSession } from "../cc/registry.ts";
import { httpError } from "../http.ts";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const MAX_PREVIEW_BYTES = 256 * 1024;

interface ArtifactRow {
  id: string;
  session_id: string | null;
  path: string;
  kind: string;
  size: number;
  thumb_path: string | null;
  created_at: string;
  meta: string | null;
  session_title: string | null;
}

function toSummary(row: ArtifactRow): ArtifactSummary {
  return {
    id: row.id,
    sessionId: row.session_id ?? "",
    path: row.path,
    kind: row.kind as ArtifactKind,
    size: row.size,
    createdAt: row.created_at,
    hasThumb: row.thumb_path !== null,
  };
}

/** 从会话消息里提取被写入/编辑过的文件。增量进行,游标存在 kv 里 */
export function collectArtifacts(sessionId: string): number {
  const offsetKey = `artifacts.offset.${sessionId}`;
  const from = Number(kvGet(offsetKey) ?? 0) || 0;

  const session = db.prepare("SELECT title FROM sessions WHERE id = ?").get(sessionId) as
    | { title: string | null }
    | undefined;

  const rows = db
    .prepare("SELECT id, content FROM messages WHERE session_id = ? AND role = 'assistant' AND id > ? ORDER BY id")
    .all(sessionId, from) as { id: number; content: string }[];
  if (rows.length === 0) return 0;

  let touched = 0;
  // 同一文件被反复改动时只保留一条,收件箱按文件而不是按改动次数呈现
  const upsert = db.prepare(
    `INSERT INTO artifacts (id, session_id, path, kind, size, sha256, thumb_path, created_at, meta, session_title)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       size = excluded.size,
       kind = excluded.kind,
       created_at = excluded.created_at,
       meta = excluded.meta,
       session_title = excluded.session_title`,
  );

  for (const row of rows) {
    let blocks: unknown;
    try {
      blocks = JSON.parse(row.content);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      const b = block as { type?: string; name?: string; id?: string; input?: Record<string, unknown> };
      if (b?.type !== "tool_use" || !b.name || !WRITE_TOOLS.has(b.name)) continue;

      const input = b.input ?? {};
      const filePath =
        typeof input.file_path === "string"
          ? input.file_path
          : typeof input.notebook_path === "string"
            ? input.notebook_path
            : null;
      if (!filePath) continue;

      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch {
        size = 0;
      }

      const id = artifactIdOf(sessionId, filePath);

      const exists = db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id) as { id: string } | undefined;
      upsert.run(
        id,
        sessionId,
        filePath,
        kindOf(filePath),
        size,
        nowIso(),
        JSON.stringify({ tool: b.name, input }),
        session?.title ?? null,
      );
      if (!exists) touched += 1;
    }
  }

  const lastId = rows[rows.length - 1]?.id ?? from;
  kvSet(offsetKey, String(lastId));
  return touched;
}

/**
 * 产物主键口径从「改动事件」改为「文件」,旧库里的 id 会与新口径并存成重复条目。
 * 用 kv 标记做一次性清空,重新收集即可。
 */
function migrateArtifactScheme(): void {
  const SCHEME = "v2";
  if (kvGet("artifacts.scheme") === SCHEME) return;
  db.prepare("DELETE FROM artifacts").run();
  const keys = db.prepare("SELECT k FROM kv WHERE k LIKE 'artifacts.offset.%'").all() as { k: string }[];
  for (const row of keys) db.prepare("DELETE FROM kv WHERE k = ?").run(row.k);
  kvSet("artifacts.scheme", SCHEME);
}

migrateArtifactScheme();

/**
 * 无 sessionId 时的全量增量收集 —— 收件箱走的就是这条路径。
 *
 * 原先这里什么都不干(`if (sessionId) collectArtifacts(sessionId)`),于是
 * **收件箱永远收集不到新产物**:新会话写出的文件根本不会出现在列表里,看到的
 * 只有库里早先已有的旧记录。用户点「刷新」打的也是这个不带 sessionId 的接口,
 * 所以刷新也救不回来 —— 得先去会话页打开那个会话才会被登记。
 *
 * 用 TTL 节流,是因为 collectArtifacts 会同步做 fs.statSync + 逐条 JSON.parse,
 * 而链路一旦判定成"不通",App 会 2 秒问一次这个接口 —— 不挡一下会把事件循环拖住。
 * 它内部是按 offset 增量走的,所以重复调用不会重复登记。
 */
let lastFullCollectAt = 0;
const FULL_COLLECT_TTL_MS = 3_000;
/** 只扫最近更新的这些会话。老会话的产物早就登记过了,没必要每轮都翻 */
const FULL_COLLECT_SESSIONS = 60;

function collectAllArtifacts(): void {
  const now = Date.now();
  if (now - lastFullCollectAt < FULL_COLLECT_TTL_MS) return;
  lastFullCollectAt = now;

  // 后台慢慢收,而且**每处理一个会话就让出一次事件循环**。
  //
  // 两个坑都得躲:
  //   1. 不能同步跑 —— 冷启动(库里还没有 offset 记录)扫 60 个会话要 10 秒,
  //      收件箱第一次打开就是转十秒圈;
  //   2. 光包一层 setImmediate 也不够 —— 那层回调自己还是同步阻塞的,而 res.end()
  //      的底层写入同样要等事件循环,结果响应照样排在它后面出不去。
  // 所以循环里每次让出一次,响应和别的请求就能插进来。有 offset 之后每轮只要几十毫秒,
  // 这笔开销只在第一次(以及新会话第一次)付。
  setImmediate(async () => {
    const rows = allRows<{ id: string }>(
      "SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ?",
      FULL_COLLECT_SESSIONS,
    );
    for (const r of rows) {
      // 单个会话解析失败不该拖垮整轮 —— 别的会话的产物还是要收上来的
      try {
        collectArtifacts(r.id);
      } catch {
        /* 跳过这个会话 */
      }
      await new Promise((res) => setImmediate(res));
    }
  });
}

export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/artifacts", async (req) => {
    const { sessionId, limit } = req.query as { sessionId?: string; limit?: string };
    const take = Math.min(Number(limit) || 50, 200);

    if (sessionId) collectArtifacts(sessionId);
    else collectAllArtifacts();

    const rows = sessionId
      ? allRows<ArtifactRow>(
          "SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
          sessionId,
          take,
        )
      : allRows<ArtifactRow>("SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?", take);

    return rows.map(toSummary);
  });

  app.post("/api/artifacts/refresh", async (req) => {
    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId) throw httpError(400, "需要 sessionId");
    return { created: collectArtifacts(sessionId) };
  });

  app.get("/api/artifacts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    if (!row) return reply.code(404).send({ error: "产物不存在" });

    let content: string | null = null;
    let diff: string | null = null;

    const meta = row.meta ? (JSON.parse(row.meta) as { tool?: string; input?: Record<string, unknown> }) : null;
    const input = meta?.input ?? {};

    if (meta?.tool === "Edit" || meta?.tool === "MultiEdit") {
      const oldText = typeof input.old_string === "string" ? input.old_string : "";
      const newText = typeof input.new_string === "string" ? input.new_string : "";
      diff = [
        ...oldText.split("\n").map((l) => `- ${l}`),
        ...newText.split("\n").map((l) => `+ ${l}`),
      ].join("\n");
    }

    try {
      const stat = await fsp.stat(row.path);
      if (stat.size <= MAX_PREVIEW_BYTES) {
        content = await fsp.readFile(row.path, "utf8");
      }
      if (stat.size !== row.size) {
        db.prepare("UPDATE artifacts SET size = ? WHERE id = ?").run(stat.size, id);
      }
    } catch {
      content = null;
    }

    const detail: ArtifactDetail = { ...toSummary({ ...row, size: row.size }), content, diff };
    return detail;
  });

  /** 把手机上的批注作为下一条用户消息发回该会话 */
  app.post("/api/artifacts/:id/comment", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text, runId } = req.body as { text?: string; runId?: string };
    if (!text?.trim()) throw httpError(400, "批注内容为空");

    const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    if (!row) return reply.code(404).send({ error: "产物不存在" });

    const session = runId ? getSession(runId) : row.session_id ? activeSessionForCcId(row.session_id) : null;
    if (!session) {
      return reply.code(409).send({
        error: "该会话当前没有活跃连接,先在会话页继续它,再发这条批注",
        hint: row.session_id,
      });
    }

    session.send(`关于文件 ${row.path}:\n${text.trim()}`);
    recordAudit(deviceFromRequest(req)?.id ?? null, "artifact.comment", row.path, "ok", text.slice(0, 200));
    return { ok: true, runId: session.runId };
  });
}
