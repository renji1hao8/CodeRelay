import { parentPort } from "node:worker_threads";
import { db } from "../db.ts";
import { ensureIndexFresh, indexSession } from "./indexer.ts";
import { startUsageScanner } from "./usage.ts";
import { readLocalCodex } from "./codex-local.ts";
import fs from "node:fs";

startUsageScanner();
parentPort!.on("message", ({ requestId, method, id, cursor }) => {
  try {
    if (method === "codexDetail") { parentPort!.postMessage({ requestId, value: readLocalCodex(id, cursor) }); return; }
    if (method === "sessions") {
      ensureIndexFresh();
      const rows = db.prepare("SELECT id,title,last_prompt,project_path,updated_at FROM sessions WHERE COALESCE(archived,0)=0 ORDER BY updated_at DESC LIMIT 300").all();
      parentPort!.postMessage({ requestId, value: rows }); return;
    }
    let row = db.prepare("SELECT file_path FROM sessions WHERE id=?").get(id) as { file_path: string } | undefined;
    if (!row) { ensureIndexFresh(); row = db.prepare("SELECT file_path FROM sessions WHERE id=?").get(id) as typeof row; }
    if (!row) throw new Error("没有这条会话的本地历史");
    indexSession(id, row.file_path);
    if (method === "claudeIdentity") {
      const metadata = db.prepare("SELECT project_path FROM sessions WHERE id=?").get(id) as { project_path: string };
      const uuids = (db.prepare("SELECT uuid FROM messages WHERE session_id=? AND uuid IS NOT NULL ORDER BY id DESC LIMIT 8").all(id) as { uuid: string }[]).map(r => r.uuid).reverse();
      if (uuids.length < 2) throw new Error("这条会话的历史过少，无法核实桌面恢复入口");
      parentPort!.postMessage({ requestId, value: { id, cwd: metadata.project_path, modifiedAt: fs.statSync(row.file_path).mtimeMs, uuids } }); return;
    }
    const before = cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 0) throw new Error("历史游标无效");
    const rows = db.prepare("SELECT id,uuid,role,ts,content FROM messages WHERE session_id=? AND id<? ORDER BY id DESC LIMIT 81").all(id, before) as any[];
    const selected = rows.slice(0, 80).reverse();
    parentPort!.postMessage({ requestId, value: {
      messages: selected.map(r => ({ uuid: r.uuid ?? `history-${r.id}`, role: r.role, ts: r.ts, blocks: JSON.parse(r.content).filter((b: any) => b.type !== "thinking") })),
      olderCursor: rows.length > 80 ? String(selected[0].id) : null,
    } });
  } catch (error) {
    parentPort!.postMessage({ requestId, error: error instanceof Error ? error.message : "历史读取失败" });
  }
});
