import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

/**
 * 会话图片的内容寻址存储。
 *
 * 图片在 jsonl 里是 base64,直接把它下发给手机会让每次会话详情请求都拖着几百 KB
 * 走隧道。所以这里把字节落到 uploads/,消息块只留**路径**,由手机的 Image 组件
 * 走 /api/fs/download 按需取 —— 那条路由已经有 token 鉴权和 inline 语义。
 *
 * 按内容哈希命名带来三个好处:同一张图只存一份;重复发送不会撑大磁盘;
 * 落盘是幂等的,所以历史回放时对同一条消息反复解析也不会重复写。
 */

/** Claude 的 Messages API 认这四种;声明成别的类型会在请求上游时被拒 */
const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** 与 Messages API 的单图上限一致。手机端已经压过一轮,这里是兜底 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const SUPPORTED_IMAGE_TYPES = Object.keys(IMAGE_EXT);

export interface StoredImage {
  /** 落盘绝对路径,落点保证在 config.uploadsDir 内 */
  path: string;
  size: number;
  mediaType: string;
}

export function storeImageBuffer(mediaType: string, buf: Buffer): StoredImage | null {
  const ext = IMAGE_EXT[mediaType];
  if (!ext || buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;

  const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32);
  const dest = path.join(config.uploadsDir, hash + ext);

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    // 先写临时名再改名:中途失败或被中断时不会在 uploads 里留下半个文件
    // 被后续请求当成有效图片发出去。
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
    } catch (err) {
      // 并发写同一张图时后到的那个可能撞上 rename 竞争,此时文件已经在了,不算错
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 临时文件可能压根没建起来 */
      }
      if (!fs.existsSync(dest)) throw err;
    }
  }

  return { path: dest, size: buf.length, mediaType };
}

/** 从 base64 落盘。data 不带 `data:` 前缀 */
export function storeImage(mediaType: string, data: string): StoredImage | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(data, "base64");
  } catch {
    return null;
  }
  return storeImageBuffer(mediaType, buf);
}

/**
 * 判断任意路径是不是我们存的图片,是则给出 mediaType。
 * 用于回放:jsonl 里可能已经是新版记的路径块,不必再走一遍 base64。
 */
export function imageMediaTypeOf(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  for (const [mediaType, e] of Object.entries(IMAGE_EXT)) {
    if (e === ext) return mediaType;
  }
  return null;
}
