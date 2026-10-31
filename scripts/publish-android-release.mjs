// 把刚编出来的 APK 发布到后端,让手机能自更新。
//
// 产物两样,都落在 server/data/releases/(整个 server/data/ 在 .gitignore 里,
// 不提交;删了重发一次即可):
//   <versionName>-<versionCode>.apk   包本体
//   manifest.json                     版本信息 —— 后端 GET /api/app/release 读的就是它
//
// 判"手上是不是新包"靠 **APK 的时间戳**,不看大小：
// QQ / 网盘客户端那类会一直攥着文件句柄,gradle 的 packageRelease 删不掉输出目录就
// BUILD FAILED —— 于是 **JS bundle 更新了、APK 没产出**,而新旧包大小几乎一样。
// 拿着旧包能白折腾半天,所以这里直接拒绝比上次发布的还旧的包。
//
// 用法:
//   node scripts/publish-android-release.mjs
//   node scripts/publish-android-release.mjs --notes "修了切屏回来审批卡片全没的毛病"
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const APK = path.join(ROOT, "mobile/android/app/build/outputs/apk/release/app-release.apk");
const OUT_DIR = path.join(ROOT, "server/data/releases");
const MANIFEST = path.join(OUT_DIR, "manifest.json");

function fail(msg) {
  console.error(`\n!!! ${msg}`);
  process.exit(1);
}

// —— 版本号(唯一真相是 mobile/app.json) ——
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "mobile/app.json"), "utf8")).expo;
const versionCode = cfg?.android?.versionCode;
const versionName = cfg?.version;
if (!Number.isInteger(versionCode) || versionCode < 1) {
  fail(`mobile/app.json 的 expo.android.versionCode 不是 >=1 的整数:${JSON.stringify(versionCode)}`);
}
if (typeof versionName !== "string" || !versionName) fail("mobile/app.json 的 expo.version 缺失");

if (!fs.existsSync(APK)) {
  fail(`找不到 APK:\n    ${APK}\n    先跑 bash scripts/build-android-apk.sh`);
}
const stat = fs.statSync(APK);

// —— 坑 19 的守卫:包必须比上次发布的更新 ——
let prev = null;
try {
  prev = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
} catch {
  // 第一次发布,或者 releases 被删过 —— 都不是错
}
if (prev?.publishedAt) {
  const prevAt = Date.parse(prev.publishedAt);
  if (Number.isFinite(prevAt) && stat.mtimeMs < prevAt) {
    fail(
      `这个 APK 比上次发布的还旧,八成是构建没产出新包(坑 19)。\n` +
        `    手上这个:${new Date(stat.mtimeMs).toLocaleString()}\n` +
        `    上次发布:${new Date(prevAt).toLocaleString()} (v${prev.versionName} / ${prev.versionCode})\n` +
        `    回去看一眼那次 gradle 是不是 BUILD FAILED。`,
    );
  }
}

// —— 算 sha256(流式,APK 几十到上百 MB,别整个读进内存) ——
const sha256 = await new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  fs.createReadStream(APK)
    .on("error", reject)
    .on("data", (chunk) => hash.update(chunk))
    .on("end", () => resolve(hash.digest("hex")));
});

// —— 落盘 ——
fs.mkdirSync(OUT_DIR, { recursive: true });
const fileName = `remotecc-${versionName}-${versionCode}.apk`;
const dest = path.join(OUT_DIR, fileName);
fs.copyFileSync(APK, dest);

const notesIdx = process.argv.indexOf("--notes");
const notes = notesIdx >= 0 ? process.argv[notesIdx + 1] ?? null : null;

const manifest = {
  versionCode,
  versionName,
  file: fileName,
  sha256,
  sizeBytes: stat.size,
  notes,
  publishedAt: new Date().toISOString(),
};
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

// —— 清掉旧包,别让它无限堆积 ——
// 目录是"可以随便删"的那一类,而且旧包对手机没有意义(比较只看 versionCode,
// 而版本只增不减)。删不掉不算错:多半是有人正拿着它/正下着它。
let pruned = 0;
for (const name of fs.readdirSync(OUT_DIR)) {
  if (!name.endsWith(".apk") || name === fileName) continue;
  try {
    fs.unlinkSync(path.join(OUT_DIR, name));
    pruned += 1;
  } catch {
    /* 被占用就留着,下次再说 */
  }
}

const mb = (stat.size / 1024 / 1024).toFixed(1);
console.log(`\n已发布 ${versionName} (versionCode ${versionCode})`);
console.log(`  文件   ${dest}`);
console.log(`  大小   ${mb} MB`);
console.log(`  sha256 ${sha256}`);
console.log(`  时间戳 ${new Date(stat.mtimeMs).toLocaleString()}`);
if (notes) console.log(`  说明   ${notes}`);
if (pruned) console.log(`  清理   ${pruned} 个旧包`);
if (prev && prev.versionCode === versionCode) {
  console.log(`\n⚠️ 上次发布的也是 versionCode ${versionCode} —— 同一个号发两次。`);
  console.log("   手机会认为「已经是最新的」而不提示更新。要是刚改过代码,留意构建脚本是否真的重编了。");
}
