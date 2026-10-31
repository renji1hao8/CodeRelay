import crypto from "node:crypto";
import path from "node:path";
import type { ArtifactKind } from "@remote-cc/shared";

/**
 * 文件路径 → 产物档位。**Claude 与 Codex 两条产物路共用这一份**。
 *
 * 原来它长在 `routes/artifacts.ts` 里(扫 Claude jsonl 那条路)。Codex 的产物是另
 * 一条数据来源(`fileChange` item),但"这是什么档位的文件"这件事两边一模一样 ——
 * 复制一份的后果是两页的图标/标签对不上,而且要改就得记着改两处。
 *
 * ⚠️ `ArtifactKind` 还有一档 `"diff"`,这里**永远不返回**它 —— 那是"这个产物本身
 * 就是一份补丁"的意思,不是按扩展名判出来的。
 */
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);
const DOC_EXT = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".tex", ".rtf"]);
const MARKDOWN_EXT = new Set([".md", ".markdown"]);

export function kindOf(filePath: string): ArtifactKind {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (DOC_EXT.has(ext)) return "report";
  return "code";
}

/**
 * 产物 id 的口径:**`sha1(归属者:文件路径)` 前 24 位**。
 *
 * Claude 那边(`routes/artifacts.ts`)一直就是算,Codex 这边照抄同一个口径 ——
 * 于是"同一条会话里的同一个文件"在两条路上拿到同一个 id,界面上的 key、
 * 以及"这个 id 认不认识"的判断都不用分叉。
 */
export function artifactIdOf(ownerId: string, filePath: string): string {
  return crypto.createHash("sha1").update(`${ownerId}:${filePath}`).digest("hex").slice(0, 24);
}
