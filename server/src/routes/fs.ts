import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { sendRange } from "../send-range.ts";
import type { DeleteIntentResponse, FsEntry, FsListResponse, FsReadResponse, FsRootsResponse } from "@remote-cc/shared";
import { config } from "../config.ts";
import { deviceFromRequest } from "../auth.ts";
import { recordAudit, db } from "../db.ts";
import { HttpError, httpError } from "../http.ts";
import {
  assertCanCreate,
  assertCanDelete,
  assertDestFits,
  assertSafe,
  isRoot,
  mimeOf,
  uniqueName,
  uploadNameOf,
  withinRoots,
  writeModeOf,
} from "../paths.ts";

/**
 * `/api/fs/read`(预览)的体积上限。
 *
 * ⚠️ 2026-09-19 从 512KB 提到 5MB。原来那个值挡住了**所有 PDF** —— 而 PDF 恰恰是
 * 手机上最常要预览的东西之一(文档、报告、导出件基本都过 512KB)。超限时后端回 413,
 * 但真机上看到的是这句英文 —— `{"error":"Payload Too Large"}`,使用者根本不知道
 * 是"文件太大,该改用下载"。所以这次不只是放宽,顺带把上限本身当作可读信息。
 *
 * 为什么不是无限:这条路由是把整个文件**读进内存再 base64** 塞进 JSON 返回的
 * (见下面的 readFile + toString),不像 /api/fs/download 是流式的。
 * 5MB 的文件 base64 后约 6.7MB,再加 JSON 包装 —— 这是这条同步路由能承受的量级。
 * 更大的东西本来也该走 download。
 */
const MAX_READ_BYTES = 5 * 1024 * 1024;
const CONFIRM_TTL_MS = 2 * 60_000;

/** 删除确认令牌:先取令牌再删除,防止一次误触就抹掉文件 */
const confirmTokens = new Map<string, { token: string; expiresAt: number }>();

export async function fsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/fs/roots", async (): Promise<FsRootsResponse> => ({
    roots: config.roots.map((r) => ({
      path: r,
      exists: fs.existsSync(r),
      writeMode: writeModeOf(r),
    })),
  }));

  app.get("/api/fs/list", async (req) => {
    const { path: target } = req.query as { path?: string };
    if (!target) throw httpError(400, "需要 path");
    const safe = await assertSafe(target);

    const stat = await fsp.stat(safe);
    if (!stat.isDirectory()) throw httpError(400, "不是目录");

    const dirents = await fsp.readdir(safe, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const d of dirents) {
      const full = path.join(safe, d.name);
      let size = 0;
      let mtime = new Date(0).toISOString();
      try {
        const st = await fsp.lstat(full);
        size = st.size;
        mtime = st.mtime.toISOString();
      } catch {
        continue;
      }
      entries.push({
        name: d.name,
        path: full,
        kind: d.isDirectory() ? "dir" : "file",
        size,
        mtime,
      });
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));

    const parent = path.dirname(safe);
    const response: FsListResponse = {
      path: safe,
      // 已经在根上时 parent 必须是 null —— 否则"上一级"会走进根**外面**的普通目录
      // (uploads 就在 E:\…\server\data 下面,退出去会看到 data,而不是回到盘符列表)。
      parent: !isRoot(safe) && withinRoots(parent) && parent !== safe ? parent : null,
      writeMode: writeModeOf(safe),
      entries,
    };
    return response;
  });

  app.get("/api/fs/read", async (req) => {
    const { path: target } = req.query as { path?: string };
    if (!target) throw httpError(400, "需要 path");
    const safe = await assertSafe(target);

    const stat = await fsp.stat(safe);
    if (stat.isDirectory()) throw httpError(400, "这是目录");
    if (stat.size > MAX_READ_BYTES) throw httpError(413, `文件过大(${stat.size} 字节),请改用下载`);

    const mime = mimeOf(safe);
    const isText = mime.startsWith("text/") || mime === "application/json";
    const buf = await fsp.readFile(safe);

    const response: FsReadResponse = {
      path: safe,
      size: stat.size,
      truncated: false,
      encoding: isText ? "utf8" : "base64",
      mime,
      text: isText ? buf.toString("utf8") : buf.toString("base64"),
    };
    return response;
  });

  app.get("/api/fs/download", async (req, reply) => {
    const { path: target, inline } = req.query as { path?: string; inline?: string };
    if (!target) throw httpError(400, "需要 path");
    const safe = await assertSafe(target);

    const stat = await fsp.stat(safe);
    if (stat.isDirectory()) throw httpError(400, "这是目录");

    recordAudit(deviceFromRequest(req)?.id ?? null, "fs.download", safe, "ok");
    reply
      .header("content-type", mimeOf(safe))
      .header(
        "content-disposition",
        `${inline === "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.basename(safe))}`,
      );
    // 支持 Range —— **断点续传的前提**。这条链路会中途断,没有它断了就只能从头再来。
    // ⚠️ 返回的是 reply 时要 `return` 出去(见 send-range.ts 的说明)
    const ranged = sendRange(req, reply, safe, stat.size);
    if (ranged) return ranged;
    reply.header("content-length", String(stat.size));
    return reply.send(fs.createReadStream(safe));
  });

  app.post("/api/fs/mkdir", async (req, reply) => {
    const { path: target } = req.body as { path?: string };
    if (!target) throw httpError(400, "需要 path");
    const safe = await assertSafe(target, true);
    assertCanCreate(safe);
    await fsp.mkdir(safe, { recursive: true });
    recordAudit(deviceFromRequest(req)?.id ?? null, "fs.mkdir", safe, "ok");
    return reply.code(201).send({ ok: true, path: safe });
  });

  app.post("/api/fs/delete-intent", async (req, reply) => {
    const { path: target } = req.body as { path?: string };
    if (!target) throw httpError(400, "需要 path");
    const safe = await assertSafe(target);
    // 删除分成"取令牌"和"真删"两步,两步都要挡:只挡后一步的话,用户会先拿到
    // 一个看起来正常的确认框,点下去才被拒 —— 白跑一趟,还以为是服务器坏了。
    assertCanDelete(safe);
    const stat = await fsp.stat(safe);

    const token = crypto.randomBytes(16).toString("base64url");
    const expiresAt = Date.now() + CONFIRM_TTL_MS;
    confirmTokens.set(safe, { token, expiresAt });

    const response: DeleteIntentResponse = {
      confirmToken: token,
      path: safe,
      kind: stat.isDirectory() ? "dir" : "file",
      size: stat.size,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    return response;
  });

  app.delete("/api/fs/entry", async (req, reply) => {
    const { path: target, confirm } = req.query as { path?: string; confirm?: string };
    if (!target || !confirm) throw httpError(400, "需要 path 与 confirm");
    const safe = await assertSafe(target);
    assertCanDelete(safe);

    const record = confirmTokens.get(safe);
    if (!record || record.token !== confirm || Date.now() > record.expiresAt) {
      recordAudit(deviceFromRequest(req)?.id ?? null, "fs.delete", safe, "denied", "确认令牌无效或已过期");
      throw httpError(403, "删除确认令牌无效或已过期,请重新发起删除");
    }
    confirmTokens.delete(safe);

    const stat = await fsp.lstat(safe);
    await fsp.rm(safe, { recursive: stat.isDirectory(), force: false });
    recordAudit(deviceFromRequest(req)?.id ?? null, "fs.delete", safe, "ok");
    return { ok: true, path: safe };
  });

  app.post("/api/fs/upload", async (req, reply) => {
    const deviceId = deviceFromRequest(req)?.id ?? null;
    let targetDir: string | null = null;
    const written: string[] = [];

    for await (const part of req.parts()) {
      if (part.type === "field" && part.fieldname === "path") {
        targetDir = String(part.value);
        continue;
      }
      if (part.type !== "file") continue;
      if (!targetDir) {
        await part.toBuffer();
        throw httpError(400, "请先传 path 字段指定目标目录");
      }
      const safeDir = await assertSafe(targetDir);
      assertCanCreate(safeDir);
      // ⚠️ 文件名要走 `uploadNameOf`(安卓那边送来的是 percent-encoded 的),
      //    再量一下总长 —— 见那两个函数里的说明,少任何一步都会变成一条查不出来的 ENOENT
      const safeName = uploadNameOf(part.filename);
      // 撞名就存副本(名字(2).后缀),不覆盖 —— 「只能添加」不该变相获得删除能力
      const dest = path.join(safeDir, await uniqueName(safeDir, safeName));
      assertDestFits(dest);
      if (!withinRoots(dest)) throw httpError(403, "目标路径越界");
      await fsp.writeFile(dest, await part.toBuffer());
      written.push(dest);
    }

    if (written.length === 0) throw httpError(400, "没有收到文件");
    recordAudit(deviceId, "fs.upload", written.join(", "), "ok");
    return reply.code(201).send({ ok: true, files: written });
  });

  /**
   * 手机在**对话里**发过来的文件(任意类型)。
   *
   * 和 /api/fs/upload 的区别:那个是"传到某个目录里",调用方得先知道往哪传;
   * 这个不用 —— 落点固定,返回路径,由调用方把路径带进消息正文。
   *
   * 为什么非图片只能这么走:Agent SDK 的消息内容只认 text 与 image 两种块,
   * 任意文件塞不进去。所以"发文件"实际是"传到电脑上 + 把路径告诉 CC" ——
   * 这也是 Claude Code 在桌面端的用法。
   *
   * 保留原文件名(撞名加序号),因为它的用途就是被引用,哈希名没法看。
   */
  app.post("/api/attach", async (req, reply) => {
    const deviceId = deviceFromRequest(req)?.id ?? null;
    await fsp.mkdir(config.attachmentsDir, { recursive: true });

    const files: { name: string; path: string; size: number }[] = [];
    for await (const part of req.parts()) {
      if (part.type !== "file") continue;
      const safeName = uploadNameOf(part.filename);
      const dest = path.join(config.attachmentsDir, await uniqueName(config.attachmentsDir, safeName));
      assertDestFits(dest);
      await fsp.writeFile(dest, await part.toBuffer());
      const st = await fsp.stat(dest);
      files.push({ name: path.basename(dest), path: dest, size: st.size });
    }

    if (files.length === 0) throw httpError(400, "没有收到文件");
    recordAudit(deviceId, "fs.attach", files.map((f) => f.path).join(", "), "ok");
    return reply.code(201).send({ files });
  });

  /**
   * 把一段文本存成文件,返回路径。
   *
   * 为什么需要它:**安卓的剪贴板 buffer 只有 4096 字符**。对话里复制长回复会被
   * 截断 —— 而截断比失败更糟,拿到半截内容还不知道少了什么。所以长内容改走
   * "存成文件 + 复制路径":路径只有几十字节,永远塞得进剪贴板,内容也是完整的。
   */
  app.post("/api/export", async (req, reply) => {
    const { text, hint } = req.body as { text?: string; hint?: string };
    if (!text?.trim()) throw httpError(400, "需要 text");

    await fsp.mkdir(config.exportsDir, { recursive: true });
    // ⚠️ 用**本地时间**而不是 toISOString()。后者是 UTC,在东八区会让凌晨导出
    // 的文件名落到前一天,和文件系统显示的时间对不上,翻起来很别扭。
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    // 文件名里不能有分隔符和通配符 —— 提示语是调用方给的,得先消毒
    const slug = (hint ?? "对话片段").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 40);
    const dest = path.join(config.exportsDir, `${stamp}-${slug}.md`);
    await fsp.writeFile(dest, text, "utf8");

    recordAudit(deviceFromRequest(req)?.id ?? null, "fs.export", dest, "ok");
    return reply.code(201).send({ path: dest, bytes: Buffer.byteLength(text, "utf8") });
  });

  app.get("/api/audit", async (req) => {
    const { limit } = req.query as { limit?: string };
    const take = Math.min(Number(limit) || 100, 500);
    const rows = db
      .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?")
      .all(take) as {
      id: number;
      ts: string;
      device_id: string | null;
      action: string;
      target: string | null;
      result: string;
      detail: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      deviceId: r.device_id,
      action: r.action,
      target: r.target,
      result: r.result,
      detail: r.detail,
    }));
  });
}
