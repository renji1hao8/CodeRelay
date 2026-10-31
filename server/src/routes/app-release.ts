import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { sendRange } from "../send-range.ts";
import type { AppReleaseResponse } from "@remote-cc/shared";
import { config } from "../config.ts";
import { httpError } from "../http.ts";
import { recordAudit } from "../db.ts";
import { deviceFromRequest } from "../auth.ts";

/**
 * 手机自更新:电脑上那个 APK 的版本信息与文件本体。
 *
 * ## 为什么分发走后端,而不是 GitHub Release
 *
 * 仓库是**私有**的,手机从 GitHub 拿 release 需要再持有一份凭据;而后端本来就有完整的
 * 设备 token 鉴权,手机也本来只连这一个地址 —— 多一个分发渠道就多一处要维护的秘密。
 * APK 落在 `config.releasesDir`(`server/data/releases/`),由
 * `scripts/publish-android-release.mjs` 写。
 *
 * ## 两条都**不**在 PUBLIC_PATHS 里
 *
 * 它们要设备 token(`index.ts` 的全局 onRequest 守卫)。APK 本身不是秘密,但
 * "这台机器在跑什么版本"没必要摊给公网上随便一个扫描器。
 *
 * ⚠️ `/api/app/release` 只回**版本信息**、不回 URL —— 让 App 用它手上那个 baseUrl 去拼,
 * 少一处"服务器返回的地址和 App 连的地址对不上"的配置面。
 */

interface ReleaseManifest {
  versionCode: number;
  versionName: string;
  /** 文件名。**只取 basename** —— 清单是我们自己写的,但不给路径穿越留门 */
  file: string;
  sha256: string;
  sizeBytes: number;
  notes?: string | null;
  publishedAt: string;
}

const MANIFEST = "manifest.json";

/**
 * 读清单。**任何**读不出来的情况都返回 null,由调用方转成 404。
 *
 * 这里刻意不抛异常、也不区分"目录不在"和"清单坏了":`server/data/` 是可以随手删的
 * (见根 CLAUDE.md 的「可以随便删的东西」),而这两种情况对使用者是同一件事 ——
 * "电脑上还没有可更新的包"。区分它们只会让手机上多一句他不需要懂的细节。
 */
async function readManifest(): Promise<ReleaseManifest | null> {
  try {
    const raw = await fsp.readFile(path.join(config.releasesDir, MANIFEST), "utf8");
    const m = JSON.parse(raw) as ReleaseManifest;
    if (
      !Number.isInteger(m?.versionCode) ||
      typeof m.file !== "string" ||
      !m.file ||
      typeof m.sha256 !== "string" ||
      !m.sha256 ||
      typeof m.sizeBytes !== "number"
    ) {
      return null;
    }
    return m;
  } catch {
    return null;
  }
}

export async function appReleaseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/app/release", async () => {
    const m = await readManifest();
    if (!m) throw httpError(404, "电脑上还没有发布过可安装的 APK");

    const out: AppReleaseResponse = {
      versionCode: m.versionCode,
      versionName: typeof m.versionName === "string" ? m.versionName : "",
      sha256: m.sha256,
      sizeBytes: m.sizeBytes,
      notes: typeof m.notes === "string" && m.notes ? m.notes : null,
      publishedAt: typeof m.publishedAt === "string" ? m.publishedAt : "",
    };
    return out;
  });

  app.get("/api/app/apk", async (req, reply) => {
    const m = await readManifest();
    if (!m) throw httpError(404, "电脑上还没有发布过可安装的 APK");

    const file = path.join(config.releasesDir, path.basename(m.file));
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) {
      // 清单在、文件没了。这种不一致必须说清楚 —— 否则表现是"提示有更新、一点就失败",
      // 而错误里看不出是发布没做完整。
      throw httpError(404, "清单里记着这个包,但文件不在(releases 目录被动过了?)");
    }

    recordAudit(
      deviceFromRequest(req)?.id ?? null,
      "app.apk",
      `${m.versionName || "?"}(${m.versionCode})`,
      "ok",
    );

    reply
      .header("content-type", "application/vnd.android.package-archive")
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(m.file))}`,
      );
    /**
     * 支持 Range —— 对这个包**尤其重要**:它 44MB,而这条链路实测只有几 KB/s
     * 到十几 KB/s、**而且会中途断**。没有续传,一次抖动就等于白下几十分钟。
     */
    // ⚠️ 返回的是 reply 时要 `return` 出去(见 send-range.ts 的说明)
    const ranged = sendRange(req, reply, file, stat.size);
    if (ranged) return ranged;
    reply.header("content-length", String(stat.size));
    return reply.send(fs.createReadStream(file));
  });
}
