import fsp from "node:fs/promises";
import path from "node:path";
import type { FsWriteMode } from "@remote-cc/shared";
import { config } from "./config.ts";
import { HttpError, httpError } from "./http.ts";

/**
 * 路径安全与 MIME 判定。
 *
 * 从 routes/fs.ts 提出来共用 —— 只读 WebDAV(routes/dav.ts)要一模一样的两件事:
 * 挡住白名单外的路径、按扩展名给 content-type。两处各写一份就是两份会各自漂移的
 * 安全边界,而安全边界漂移的代价不是"不好看"。
 */

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".rs", ".go", ".java", ".kt", ".c",
  ".h", ".hpp", ".cpp", ".cc", ".cs", ".rb", ".php", ".sh", ".bash", ".ps1", ".bat", ".cmd",
  ".html", ".htm", ".css", ".scss", ".sql", ".tex", ".bib", ".csv", ".tsv", ".log", ".xml", ".vue",
  ".svelte", ".lua", ".r", ".m", ".swift", ".dart", ".gradle", ".properties", ".gitignore", ".env.example",
]);

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".pdf": "application/pdf", ".zip": "application/zip", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
  ".apk": "application/vnd.android.package-archive",
  ".json": "application/json", ".md": "text/markdown", ".csv": "text/csv", ".html": "text/html",
};

export function mimeOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  if (TEXT_EXT.has(ext)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** 这个路径本身是不是一个根 */
export function isRoot(target: string): boolean {
  const resolved = path.resolve(target);
  return config.roots.some((root) => path.resolve(root) === resolved);
}

/** `target` 是否落在 `root` 里(含 root 自身) */
function within(target: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function withinRoots(target: string): boolean {
  const resolved = path.resolve(target);
  return config.roots.some((root) => within(resolved, root));
}

/**
 * 这个路径所在的根,允许 callers 对它做什么。
 *
 * 默认 `append` —— 见 config.ts 里那两个名单的说明。判定顺序是
 * readonly → full → append 兜底,所以 Z: 既是只读也不会被 full 名单捞走。
 */
export function writeModeOf(target: string): FsWriteMode {
  const resolved = path.resolve(target);
  if (config.readOnlyRoots.some((root) => within(resolved, root))) return "readonly";
  if (config.fullRoots.some((root) => within(resolved, root))) return "full";
  return "append";
}

/**
 * 新建类操作(上传、建目录)的前置。
 *
 * ⚠️ 写操作必须真的调它,不能只在界面上藏按钮。藏按钮挡的是误触,
 * 挡不住拿着 token 直接发请求的人;而拿到 token 的前提只是一台配对过的设备。
 */
export function assertCanCreate(target: string): void {
  if (writeModeOf(target) === "readonly") {
    throw httpError(403, "这个位置是只读的,请在电脑上操作");
  }
}

/** 删除的前置。默认的 `append` **什么都删不掉** —— 这是这个模式存在的理由 */
export function assertCanDelete(target: string): void {
  const mode = writeModeOf(target);
  if (mode === "readonly") throw httpError(403, "这个位置是只读的,请在电脑上操作");
  if (mode === "append") {
    throw httpError(403, "手机端只能往这里添加文件,不能删除;要删请在电脑上操作");
  }
}

/**
 * 从 multipart 的 `filename` 里取出**真正要落盘的那个名字**。
 *
 * ## 为什么必须有这一步
 *
 * ⚠️ **安卓客户端送上来的文件名是 percent-encoded 的**(2026-09-22 实测)。
 * RN 那条 FormData 链路会按 UTF-8 做百分号转义,于是
 * `1-一种隧道空间几何约束下的数据空间配准方法_专利申请文件草案.docx`(36 字)
 * 到服务端变成了 260 字的 `1-%E4%B8%80%E7%A7%8D…docx`。
 *
 * 后果有两层,而**第二层才是使用者看到的那条报错**:
 *
 *   1. 落盘的名字是一长串乱码(他那个目录里已经躺着一条了,`3-%E4%B8%80…`);
 *   2. 名字一长,`目录 + 名字` 顶破了 **Windows 的 260 字符上限** —— 而 Windows 在
 *      这种情况下报的是 **ENOENT**(没有那个文件或目录)。那看起来像"目标文件夹不在了",
 *      于是会往"文件夹被删了 / 权限 / 非 ASCII 支持"的方向查 —— 全都查不出来。
 *      (实测:同一条路径 276 字符 → ENOENT;解过码的 52 字符 → 写成功。)
 *
 * ## 动手的条件窄到只有一种
 *
 * 只有**整串里存在合法的 `%XX`** 才尝试解码,而且解出来带替换字符、或者还想跳出目录的,
 * 一律退回原样。真实的文件名里出现 `%E4%B8%80` 这种完整转义的可能性极低,
 * 而出这个问题的概率极高 —— 所以宁可解,别把一个正常的 `50%off.docx` 也搅进去
 * (`%of` 不是合法转义,`decodeURIComponent` 会抛,那一刻就原样返回)。
 */
export function uploadNameOf(raw: string | undefined): string {
  const base = path.basename(raw || "upload.bin");
  if (!/%[0-9A-Fa-f]{2}/.test(base)) return base;
  try {
    const decoded = decodeURIComponent(base);
    if (!decoded || decoded.includes("�")) return base;
    // 解出来带路径分隔符的:只取文件名,绝不让它逃出目标目录
    if (decoded.includes("/") || decoded.includes("\\")) return path.basename(decoded);
    return decoded;
  } catch {
    return base; // 不是合法转义(名字里真有个 `%`),原样留着
  }
}

/**
 * Windows 的路径总长上限。
 *
 * ⚠️ 260 是硬上限(除非系统开了长路径支持),而**超了报的是 ENOENT** ——
 * 见 `uploadNameOf` 里那段说明。留 10 个字符的余量给 `uniqueName` 加的 `(2)`。
 */
export const MAX_DEST_CHARS = 250;

/** 落盘之前先量一下总长,把那个误导性的 ENOENT 挡在前面,换成一句人能看懂的话 */
export function assertDestFits(dest: string): void {
  if (dest.length > MAX_DEST_CHARS) {
    throw httpError(
      400,
      `名字太长了:完整路径 ${dest.length} 个字符,Windows 的上限是 260。` +
        `把文件名改短一点再传(现在这个文件名 ${path.basename(dest).length} 个字符)。`,
    );
  }
}

/**
 * 在 `dir` 下给 `name` 找一个不冲突的文件名 —— 撞名就存成 `名字(2).后缀`。
 *
 * 「只能添加」模式下不能覆盖已有文件:覆盖等于变相获得了删除能力,
 * 而使用者要的是"传上去就完事,别把原来那个顶掉"。
 */
export async function uniqueName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let i = 1; i <= 999; i++) {
    const candidate = i === 1 ? name : `${stem}(${i})${ext}`;
    try {
      await fsp.access(path.join(dir, candidate));
      /* 已经存在,试下一个 */
    } catch {
      return candidate;
    }
  }
  throw httpError(409, `同名文件太多,换个名字再传:${name}`);
}

/**
 * `real` 是否落在白名单里 —— 拿根的 **realpath** 去比,而不是字面值。
 *
 * ⚠️ 这条是踩出来的。Windows 上映射的网络盘,`fsp.realpath('Z:\\')` 展开成
 * `\\主机@SSL@端口\DavWWWRoot\共享名\`,而白名单里写的是 `Z:\` —— 字面比较必然失败,
 * 现象是"Z: 明明出现在根列表里,列目录却被 403(符号链接指向了根目录之外)"。
 *
 * 顺带记一笔:`fs.realpathSync` **不**展开,它走的是 JS 实现的符号链接解析,而异步版
 * 走系统调用。别拿同步版的结果推断异步版 —— 我因此把方向搞反过一次。
 *
 * 普通盘在第一轮就命中,不多付代价;只有 real 不是字面落在某个根里时(网络盘、
 * 或者真越界的符号链接),才会去 realpath 各个根。
 */
async function withinRealRoots(real: string): Promise<boolean> {
  for (const root of config.roots) {
    if (within(real, root)) return true;
    try {
      if (within(real, await fsp.realpath(root))) return true;
    } catch {
      /* 根当前不在(卷没就绪、权限不足)—— 那就是不匹配 */
    }
  }
  return false;
}

/**
 * 目标**字面**落在某个根里,但那个根自己解析不出真实形态 —— 也就是"卷没就绪"。
 *
 * 为什么要单拎出来:Windows 上映射的网络盘断开时,`fsp.realpath('Z:\\')` 会抛,
 * 于是 withinRealRoots 一个个根都比不中,最后报的是**「符号链接指向了根目录之外」**。
 * 那句话对这种情况纯属误导 —— 使用者只是点了一下 Z:,却被说成路径越界,
 * 只会以为是自己点错了地方(实测 2026-09-19,文件页 4 次 403 全是这个)。
 */
async function rootUnresolvable(resolved: string): Promise<boolean> {
  for (const root of config.roots) {
    if (!within(resolved, root)) continue;
    try {
      await fsp.realpath(root);
      return false; // 这个根还在,那就不是"卷没就绪"
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * 规范化 → 白名单 → 解引用符号链接后再次校验,任何一步越界都拒绝。
 *
 * 第二道 realpath 检查是必要的:白名单里可以放一个指向别处的符号链接,
 * 只看字面路径的话它就成了越狱通道。但它得拿**根的真实形态**去比,
 * 否则映射的网络盘会被误判成越界 —— 见 withinRealRoots。
 */
export async function assertSafe(target: string, allowMissing = false): Promise<string> {
  if (!target || target.includes("\0")) throw httpError(400, "非法路径");
  const resolved = path.resolve(target);
  if (!withinRoots(resolved)) throw httpError(403, "路径不在允许的根目录内");

  try {
    const real = await fsp.realpath(resolved);
    if (!(await withinRealRoots(real))) {
      // 到这儿有两种可能,得分开报:真越界的符号链接,和"它所在的根自己没就绪"
      if (await rootUnresolvable(resolved)) {
        throw httpError(503, "这个位置现在连不上(映射的网络盘没就绪?)。等它挂回来再试");
      }
      throw httpError(403, "符号链接指向了根目录之外");
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (!allowMissing) throw httpError(404, "路径不存在");
  }
  return resolved;
}
