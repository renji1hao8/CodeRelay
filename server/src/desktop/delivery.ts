import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DesktopDelivery } from "@remote-cc/shared";
import { httpError } from "../http.ts";

export function createDeliveryTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS desktop_deliveries (
    request_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, target TEXT NOT NULL,
    digest TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
}
export async function deliverOnce(db: DatabaseSync, request: { requestId: string; deviceId: string; target: string; text: string }, send: () => Promise<unknown>): Promise<DesktopDelivery> {
  const { requestId, deviceId, target, text } = request;
  const digest = crypto.createHash("sha256").update(text).digest("hex");
  const prior = db.prepare("SELECT * FROM desktop_deliveries WHERE request_id=?").get(requestId) as any;
  if (prior) {
    if (prior.device_id !== deviceId || prior.target !== target || prior.digest !== digest) throw httpError(409, "消息标识已用于另一条消息");
    return { requestId, status: prior.status, acceptedAt: prior.created_at, notice: prior.status === "submitted" ? "已投递到桌面原会话" : "投递结果待核实，请先查看会话，不要重复发送" };
  }
  const acceptedAt = new Date().toISOString();
  const inserted = db.prepare("INSERT OR IGNORE INTO desktop_deliveries VALUES (?,?,?,?,?,?)")
    .run(requestId, deviceId, target, digest, "unknown", acceptedAt);
  if (!inserted.changes) return deliverOnce(db, request, send);
  try {
    await send();
    db.prepare("UPDATE desktop_deliveries SET status='submitted' WHERE request_id=?").run(requestId);
    return { requestId, status: "submitted", acceptedAt, notice: "已投递到桌面原会话；传输成功不代表模型已接收" };
  } catch {
    return { requestId, status: "unknown", acceptedAt, notice: "桌面投递未获确认；请查看原会话后决定是否重发。不会另起 CLI" };
  }
}
