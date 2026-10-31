import { Directory, File } from "expo-file-system";
import { Linking } from "react-native";
import type { Api } from "./api";
import { errText } from "./util";
import { clearDownloadDir, loadDownloadDir, saveDownloadDir } from "./storage";

export type DownloadResult =
  | { ok: true; name: string }
  | { ok: false; message: string; /** 使用者在目录选择器上点了取消 */ cancelled?: boolean };

/** 文件名里不能出现的字符 —— 它们会破坏 SAF 那边的文档名 */
function safeName(remotePath: string): string {
  const base = remotePath.split(/[\\/]/).pop() || "download";
  return base.replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * 按扩展名给 MIME。
 *
 * SAF 建文档时要它,给错不会报错、但某些文件管理器会按它决定"用什么打开" ——
 * 尤其 apk 必须是 `application/vnd.android.package-archive`,否则安装器不认。
 */
function mimeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  const table: Record<string, string> = {
    apk: "application/vnd.android.package-archive",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    csv: "text/csv",
    xml: "text/xml",
    html: "text/html",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
  };
  return table[ext] ?? "application/octet-stream";
}

/**
 * 弹一次系统的目录选择器(SAF),把选中的目录**持久化**下来。
 *
 * 取消返回 null。取消不是错误 —— 使用者点了取消就是不想下,别弹红字。
 */
async function askDownloadDir(): Promise<Directory | null> {
  try {
    const picked = await Directory.pickDirectoryAsync();
    if (!picked) return null;
    await saveDownloadDir(picked.uri);
    return picked;
  } catch {
    // expo 在"取消"时也是抛异常(而不是返回 null),这里一并当取消处理
    return null;
  }
}

/** 已保存的下载目录;没有就 null(不弹窗) */
async function currentDownloadDir(): Promise<Directory | null> {
  const saved = await loadDownloadDir();
  if (!saved) return null;
  return new Directory(saved);
}

/**
 * 下载一个文件到**使用者自己的目录**,然后交给系统打开(APK → 安装器,PDF → 阅读器…)。
 *
 * ⚠️ **为什么不能沿用 `Linking.openURL(下载地址)` 交给浏览器。**
 * 下载地址是 https,而服务器用的是**自签证书**。那张证书在 App 里被钉成了信任锚
 * (见 `patch-android-project.mjs` 的第 6 个补丁),**但浏览器不认** ——
 * 于是手机浏览器弹「你的连接不是私密连接,攻击者可能试图窃取…」,下载根本走不下去。
 * 真机上就是这么被卡住的:预览能看(走 App 自己的请求),下载却打不开。
 *
 * ⚠️ **也不能再下到 `cacheDirectory` 了。** 那是 `/data/user/0/<包名>/cache/` ——
 * App 私有目录,没 root 既进不去、文件管理器也扫不到,而且系统随时可以清掉它。
 * 使用者的原话是「我能下载,但是文件管理中找不到在哪」。
 *
 * 现在走 **SAF**:让他选一次目录(记住),之后每次直接落进去 —— 文件在
 * 文件管理器里就是可见的。这是 Android 10+ 分区存储下**唯一**没 root 也能
 * 把文件放进公共位置的官方途径(直接写 `/sdcard/Download` 已经被堵死)。
 *
 * 用 `createDownloadTask` 而不是 `downloadAsync`,只为拿到进度 ——
 * 44MB 走隧道要几分钟,没有进度条看起来就像卡死了。
 */
export async function downloadAndOpen(
  api: Api,
  remotePath: string,
  onProgress?: (ratio: number | null) => void,
): Promise<DownloadResult> {
  return downloadUrlAndOpen(api.fileUrl(remotePath), safeName(remotePath), onProgress);
}

/**
 * 同上,但直接给**已经拼好的下载地址与文件名**。
 *
 * 存在的理由是 App 自更新:它下的是 `/api/app/apk`(整包),走的不是文件页那条
 * `?path=` 的路子。**除了地址来源,后面每一步都一模一样** —— 所以是复用同一条链,
 * 而不是在别处再写一份"下载 + SAF + 交给系统安装"。
 *
 * ⚠️ 别把它改成"下到缓存目录直接装":安卓 10+ 起装包必须经过 SAF 产出的 `content://`,
 * 而缓存目录是 App 私有的(见 `downloadAndOpen` 上面那段说明)。
 */
export async function downloadUrlAndOpen(
  url: string,
  name: string,
  onProgress?: (ratio: number | null) => void,
): Promise<DownloadResult> {
  const fileName = safeName(name);

  let dir = await currentDownloadDir();
  if (!dir) {
    dir = await askDownloadDir();
    if (!dir) return { ok: false, cancelled: true, message: "没有选择保存位置,下载取消" };
  }

  try {
    return await downloadInto(dir, url, fileName, onProgress);
  } catch (err) {
    // ⚠️ 最常见的原因是**授权失效**:使用者把那个目录删了、换了张卡、或在系统设置里
    // 撤销了权限。这时保存的 URI 还在,但写不进去。清掉它重新问一次,别让使用者
    // 陷在"每次下载都失败"里出不来。
    await clearDownloadDir();
    const again = await askDownloadDir();
    if (!again) {
      return { ok: false, cancelled: true, message: `保存位置已失效(${errText(err)}),且没有重新选择` };
    }
    try {
      return await downloadInto(again, url, fileName, onProgress);
    } catch (err2) {
      return { ok: false, message: errText(err2) };
    }
  }
}

async function downloadInto(
  dir: Directory,
  url: string,
  name: string,
  onProgress?: (ratio: number | null) => void,
): Promise<DownloadResult> {
  // 同名先删掉。留着的话 SAF 的 createFile 会给新文件自动编号(`名字 (1).apk`),
  // 于是同一个东西越下越多,使用者分不清哪个是新的。
  try {
    const stale = new File(dir, name);
    if (stale.exists) stale.delete();
  } catch {
    // 删不掉不算致命(可能是只读目录),继续走 —— 最多是多一个带编号的副本
  }

  const dest = dir.createFile(name, mimeOf(name));
  /** 最后一次进度。用来在下载结束后**自己核对长度**(见下面那段) */
  let last = { written: 0, total: -1 };
  const task = File.createDownloadTask(url, dest, {
    onProgress: (p) => {
      last = { written: p.bytesWritten, total: p.totalBytes };
      onProgress?.(p.totalBytes > 0 ? p.bytesWritten / p.totalBytes : null);
    },
  });

  const out = await task.downloadAsync();
  if (!out) return { ok: false, message: "下载被中断" };

  /**
   * ⚠️ **必须自己核对长度 —— `downloadAsync()` 返回结果不等于下完了。**
   *
   * expo-file-system 的文档写着:iOS 会先在临时位置下好再搬过去,而**安卓是直接往目标
   * 文件里写** ——「If the download fails after it starts, a partially written file may
   * remain at the destination」。也就是说失败时**目标位置上留着一个残缺文件**,而
   * `downloadAsync()` 照样给你一个结果。
   *
   * 不核对的话,我们就会把一个**残缺的文件**交给系统打开:APK 会装不上(安装器报
   * "解析软件包时出现问题"),而使用者完全不知道那是"没下完"(2026-09-27 实测:
   * 45 秒的窗口里,22 秒就断了)。
   *
   * 删掉残缺文件是有意的:**宁可让他重下一次,也不要留一个看着像下好了的坏文件**
   * 在那儿(下次同名下载会先删它,所以删不删都能重来;删掉是别让人误以为能打开)。
   */
  if (last.total > 0 && last.written < last.total) {
    try {
      dest.delete();
    } catch {
      // 删不掉不算致命 —— 下一次下载会先同名删一次
    }
    return {
      ok: false,
      message: `下载不完整(收到 ${last.written} / ${last.total} 字节,链路中途断了)。可以再试一次。`,
    };
  }

  onProgress?.(1);
  // SAF 产出的本来就是 `content://`,可以直接交给系统,不需要再换一次
  await Linking.openURL(out.uri);
  return { ok: true, name };
}

/** 当前的下载目录 URI(给设置页显示用);没设过就是 null */
export async function getDownloadDir(): Promise<string | null> {
  return loadDownloadDir();
}

/** 让使用者重新挑一个下载目录(设置页用)。返回是否挑成功 */
export async function chooseDownloadDir(): Promise<boolean> {
  const dir = await askDownloadDir();
  return dir !== null;
}
