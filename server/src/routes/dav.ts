import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendRange } from "../send-range.ts";
import { config } from "../config.ts";
import { httpError } from "../http.ts";
import { assertSafe, mimeOf } from "../paths.ts";
import { davAuthOk } from "../webdav.ts";

/**
 * 只读 WebDAV。
 *
 * 让手机上的文件管理器(以及 Windows 的资源管理器)把整台电脑挂成一个网络位置。
 * 使用者的原话是「最好是能直接挂载到我手机上看」。
 *
 * **为什么手写而不引库**:只读这件事把 WebDAV 砍掉了大半 —— 不用管锁(LOCK/UNLOCK)、
 * 不用管写(PUT/DELETE/MKCOL/MOVE/COPY)、不用管属性修改(PROPPATCH)。真正需要的
 * 就三个动作:OPTIONS 报能力、PROPFIND 列目录、GET 取文件。为这点东西引一个
 * 可能已经停更的库、再迁就它的目录约定,不划算。
 *
 * **只读是刻意的**(使用者选的):公网入口上多一条写入路径,密码一旦泄露就直接
 * 能被删文件。要改东西走 App 里的文件页,或者让 AI 去干。
 */

export const PREFIX = "/dav";

/** 只列盘符,不列 uploadsDir 那种内部目录 —— 白名单里有它是因为图片要取,不是给人翻的 */
function driveRoots(): string[] {
  return config.roots.filter((r) => /^[A-Za-z]:\\?$/.test(r));
}

/** 文件系统路径 → href。逐段百分号编码:文件名里带空格、中文、`#` 都得能过去 */
function toHref(fsPath: string): string {
  const norm = path.resolve(fsPath);
  const drive = norm.slice(0, 1).toUpperCase();
  const rest = norm.slice(2).split(/[\\/]+/).filter(Boolean);
  if (rest.length === 0) return `${PREFIX}/${drive}`;
  return `${PREFIX}/${drive}/${rest.map(encodeURIComponent).join("/")}`;
}

/** href → 文件系统路径。`/dav` 或 `/dav/` 返回 null,表示"列出所有盘符" */
function toFsPath(davPath: string): string | null {
  const rest = davPath.replace(/^\/dav\/?/, "");
  if (!rest) return null;
  const segs = rest.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  const drive = segs.shift() ?? "";
  if (!/^[A-Za-z]$/.test(drive)) throw httpError(400, "第一段必须是盘符");

  // 解出来的段里不能再出现分隔符或盘符冒号。否则 `path.resolve` 遇到一个绝对路径
  // 会把前面拼好的全丢掉 —— `/dav/E/C:\Windows` 会变成 `C:\Windows`,URL 里的
  // 盘符段形同虚设。白名单仍然拦得住越界,但让映射保持严格更省心。
  for (const s of segs) {
    if (s.includes("/") || s.includes("\\") || s.includes(":")) {
      throw httpError(400, "路径段里不允许分隔符");
    }
  }
  return path.resolve(`${drive.toUpperCase()}:\\`, ...segs);
}

/**
 * 把失败转成响应码。
 *
 * ⚠️ 项目的 HttpError 把状态放在 **`status`** 字段(见 http.ts),不是 `statusCode`。
 * 查错名字的后果是它一路掉到 500 —— "文件不存在"被报成"服务器坏了",很难查。
 * 另外两条是为裸的 fs 错误兜底:assertSafe/stat 之外偶尔会直接抛它们。
 */
function statusOf(err: unknown): number {
  const e = err as { status?: number; statusCode?: number; code?: string };
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  if (e.code === "ENOENT") return 404;
  if (e.code === "EACCES" || e.code === "EPERM") return 403;
  return 500;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Entry {
  fsPath: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: Date;
}

function responseXml(e: Entry): string {
  const href = toHref(e.fsPath);
  // 目录的 href 要以 / 结尾,否则多数客户端会当成文件而不进去
  const hrefOut = e.isDir ? `${href}/` : href;
  const props = [
    `<D:displayname>${xmlEscape(e.name)}</D:displayname>`,
    `<D:getlastmodified>${e.mtime.toUTCString()}</D:getlastmodified>`,
    e.isDir
      ? `<D:resourcetype><D:collection/></D:resourcetype>`
      : `<D:resourcetype/><D:getcontentlength>${e.size}</D:getcontentlength><D:getcontenttype>${xmlEscape(mimeOf(e.fsPath))}</D:getcontenttype>`,
  ].join("");
  return `<D:response><D:href>${xmlEscape(hrefOut)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(entries: Entry[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${entries.map(responseXml).join("")}</D:multistatus>`;
}

function entryFor(fsPath: string, name: string, st: fs.Stats): Entry {
  return { fsPath, name, isDir: st.isDirectory(), size: st.size, mtime: st.mtime };
}

export async function davRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Fastify v5 把非标准 HTTP 方法从默认集里拿掉了,DAV 自带的那几个得显式登记回来,
   * 否则注册路由时直接抛 `FST_ERR_ROUTE_METHOD_NOT_SUPPORTED`(启动即挂)。
   *
   * hasBody: false —— PROPFIND 的 body 是"我要哪些属性",而我们一律全量返回,
   * 不解析它。宣称没有 body 是准确的。
   */
  for (const m of ["PROPFIND", "PROPPATCH", "MKCOL", "MOVE", "COPY", "LOCK", "UNLOCK"]) {
    app.addHttpMethod(m, { hasBody: false });
  }

  /**
   * 不解析任何请求体。
   *
   * 不加这个的话,客户端一发 PUT(带 application/octet-stream 之类)Fastify 会先按
   * content-type 报 415 —— 挡是挡住了,但"不支持这种媒体类型"完全没说清真正的原因。
   * 我们自己回 403 说明"这个挂载是只读的",对排查的人友好得多。
   *
   * 它是注册在这个插件作用域里的,不影响 App 自己的路由。
   */
  app.addContentTypeParser("*", (_req, _payload, done) => done(null, null));

  /** 所有 DAV 请求的共同前置:Basic 鉴权 */
  const authorize = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (davAuthOk(req.headers.authorization)) return true;
    reply
      .code(401)
      .header("WWW-Authenticate", 'Basic realm="remotecc", charset="UTF-8"')
      .send("unauthorized");
    return false;
  };

  app.route({
    method: ["OPTIONS", "GET", "HEAD", "PROPFIND", "POST", "PUT", "DELETE", "MKCOL", "MOVE", "COPY", "PROPPATCH", "LOCK", "UNLOCK"],
    url: `${PREFIX}/*`,
    handler: async (req, reply) => {
      if (!authorize(req, reply)) return reply;

      // DAV 的版本号。只报 1:报告 2 就得支持 LOCK,而我们是只读的
      reply.header("DAV", "1");
      const method = req.method.toUpperCase();
      const method2 = req.headers["x-http-method-override"];

      // 有些客户端(以及所有浏览器 fetch)发不出 PROPFIND,靠这个头转
      const actual = typeof method2 === "string" ? method2.toUpperCase() : method;

      if (actual === "OPTIONS") {
        reply.header("Allow", "OPTIONS, GET, HEAD, PROPFIND");
        reply.header("MS-Author-Via", "DAV");
        return reply.code(200).send();
      }

      if (actual === "PROPFIND") return handlePropfind(req, reply);
      if (actual === "GET" || actual === "HEAD") return handleGet(req, reply);

      // 其余一律拒绝。只读是刻意的,不是"还没做"
      return reply.code(403).send("forbidden: 这个挂载是只读的");
    },
  });

  async function handlePropfind(req: FastifyRequest, reply: FastifyReply) {
    let fsPath: string | null;
    try {
      fsPath = toFsPath(req.url.split("?")[0] ?? "");
    } catch {
      return reply.code(400).send("bad path");
    }

    const depth = String(req.headers.depth ?? "1") === "0" ? 0 : 1;

    // 虚拟根:列出所有盘符
    if (fsPath === null) {
      const entries: Entry[] = [];
      for (const root of driveRoots()) {
        try {
          entries.push(entryFor(root, root.replace(/\\$/, ""), await fsp.stat(root)));
        } catch {
          /* 卷没就绪就跳过 */
        }
      }
      return reply.code(207).type("application/xml; charset=utf-8").send(multistatus(entries));
    }

    let safe: string;
    let st: fs.Stats;
    try {
      safe = await assertSafe(fsPath);
      st = await fsp.stat(safe);
    } catch (err) {
      return reply.code(statusOf(err)).send("not found");
    }

    const self = entryFor(safe, path.basename(safe) || safe, st);
    if (depth === 0 || !st.isDirectory()) {
      return reply.code(207).type("application/xml; charset=utf-8").send(multistatus([self]));
    }

    const entries: Entry[] = [self];
    const names = await fsp.readdir(safe);
    for (const name of names) {
      const child = path.join(safe, name);
      try {
        entries.push(entryFor(child, name, await fsp.lstat(child)));
      } catch {
        /* 权限不足/竞态删除,跳过这一个而不是整次列目录失败 */
      }
    }
    return reply.code(207).type("application/xml; charset=utf-8").send(multistatus(entries));
  }

  async function handleGet(req: FastifyRequest, reply: FastifyReply) {
    let fsPath: string | null;
    try {
      fsPath = toFsPath(req.url.split("?")[0] ?? "");
    } catch {
      return reply.code(400).send("bad path");
    }
    if (fsPath === null) return reply.code(403).send("这是盘符列表,不是文件");

    let safe: string;
    let st: fs.Stats;
    try {
      safe = await assertSafe(fsPath);
      st = await fsp.stat(safe);
    } catch (err) {
      return reply.code(statusOf(err)).send("not found");
    }

    if (st.isDirectory()) return reply.code(403).send("这是目录");

    reply.header("content-type", mimeOf(safe));

    /**
     * Range 支持 —— **抽到 `send-range.ts` 里了,三处下载共用一份**。
     *
     * 对只读挂载不是可选项:视频/音频播放器一定要它才能拖进度 —— 没有的话它们要么
     * 整段下下来、要么直接播不动。手机上看电脑里的视频是这个挂载最主要的使用场景之一。
     *
     * ⚠️ 顺带修掉一个隐患:原来 Range **越界**时(要的起点大于文件长度)会**回整份 200**,
     * 而续传的客户端正是靠那个状态码判断"我记的偏移量不对了" —— 回一整份会让它把两份
     * 内容接在一起。现在按规范回 416。
     */
    // ⚠️ 返回的是 reply 时要 `return` 出去(见 send-range.ts 的说明)
    const ranged = sendRange(req, reply, safe, st.size);
    if (ranged) return ranged;

    reply.header("content-length", String(st.size));
    if (req.method.toUpperCase() === "HEAD") return reply.send();
    return reply.send(fs.createReadStream(safe));
  }
}
