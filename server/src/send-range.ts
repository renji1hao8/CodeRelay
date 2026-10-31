import fs from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * 带 **Range** 的发送 —— 也就是**断点续传**的前提。
 *
 * ⚠️ 为什么这几条下载路由都得有它:手机与后端之间那条链路只有**几 KB/s 到十几 KB/s**,
 * **而且会中途断**(2026-09-27 实测:45 秒的窗口里 22 秒就断了)。没有 Range,断了只能
 * 从头再来 —— 44MB 的 APK 在那种链路上等于**永远下不完**。
 *
 * 三处共用这一份(会话文件下载 / APK / WebDAV),别再各写一遍:越界 Range 该回什么、
 * HEAD 怎么办,都是"写错了看不出来、只在续传时才现形"的细节。
 *
 * ## ⚠️ 调用方**必须 return 它的返回值**
 *
 * `null` = 不是 Range 请求(或不认得这个 Range),调用方按整份发;否则返回 **reply 本身**,
 * 调用方要 `return` 出去。
 *
 * **这条是踩出来的**:抽成函数时如果在里面只调 `reply.send(stream)`、而让路由返回
 * `undefined`,Fastify 会**自己再发一个空的** —— `content-length` 是 0、body 一个字节都没有,
 * 而状态码 206 与 `content-range` 全都**看着完全正常**。原来的 `dav.ts` 那版是对的,
 * 因为它写的是 `return reply.send(...)`;搬运的时候把那个 `return` 丢了,就成了静默的空响应。
 *
 * ⚠️ 写这个文件的注释时别把「星号 + 斜杠」连在一起写 —— 那是块注释的结束符,
 * 会**提前把注释关掉**,后面的中文变成代码,报一堆看不懂的语法错(踩过)。
 */
export function sendRange(
  req: FastifyRequest,
  reply: FastifyReply,
  absPath: string,
  size: number,
): FastifyReply | null {
  reply.header("accept-ranges", "bytes");

  const range = req.headers.range;
  if (typeof range !== "string") return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return null;

  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;

  if (!Number.isFinite(start) || start > end || start >= size) {
    /**
     * 越界的 Range → **416**,不能默默给整份。
     *
     * 续传的客户端就是靠这个状态码判断"我记的那个偏移量不对了"(文件换了、或者比它
     * 以为的小)—— 回一整份 200 的话,它会以为自己要的那段就是全文,于是**把两份内容
     * 接在一起**。规范要求这里回总长而不回区间(形状见下面那行代码里的模板串)。
     */
    reply.code(416).header("content-range", `bytes */${size}`);
    return reply.send();
  }

  reply
    .code(206)
    .header("content-range", `bytes ${start}-${end}/${size}`)
    .header("content-length", String(end - start + 1));
  if (req.method.toUpperCase() === "HEAD") return reply.send();
  return reply.send(fs.createReadStream(absPath, { start, end }));
}
