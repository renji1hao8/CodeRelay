/**
 * 通知深链的解析 —— 纯函数,配用例(`scripts/check-deep-link.mjs`)。
 *
 * 三种:
 *   `remotecc://session/cc/<CC 会话 id>`     —— Claude 会话
 *   `remotecc://session/run/<runId>`         —— 按活着的进程打开
 *   `remotecc://session/codex/<thread id>`   —— Codex 会话
 *
 * ⚠️ 为什么值得抽出来单测:深链坏掉的表现是**通知点不开** —— 而那是"看着像好了、
 * 其实点不动"的那一类,不真点一次发现不了。这里的判据全在字符串上,几毫秒就能钉住。
 */

export type DeepLink = { kind: "cc" | "run" | "codex"; id: string };

/** 没带标签的老链接按 `run` 处理 —— 那是它当年的语义,别改 */
export function parseDeepLink(url: string | null | undefined): DeepLink | null {
  if (!url) return null;
  const m = /^remotecc:\/\/session\/(?:(cc|run|codex)\/)?([^/?#]+)/.exec(url);
  const id = m?.[2];
  if (!id) return null;
  const tag = m?.[1];
  /**
   * ⚠️ `remotecc://session/cc`(**有标签、没 id**)是坏链接 —— 别把它当成"id 就叫 cc"。
   *
   * 服务端不会发这种(没 id 时它发的是 `remotecc://session`),但坏链接装成一个合法 id
   * 只会把问题推到后面:真去开一条 id 是 `cc` 的会话。用例抓到过这一条。
   */
  if (!tag && (id === "cc" || id === "run" || id === "codex")) return null;
  return { kind: tag === "cc" ? "cc" : tag === "codex" ? "codex" : "run", id };
}
