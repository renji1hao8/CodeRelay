// 把 mobile/app.json 的版本号生成成 App 内的常量。
//
// 单一真相是 `mobile/app.json`;构建时会自动跑一次(见 scripts/build-android-apk.sh)。
//
// 为什么不引 `expo-application` / `expo-constants` 去运行时读:这个项目刻意少依赖
// 而"我是哪个版本"只需要**构建那刻**的一个快照 ——
// 生成一个常量就够,且与 sync-protocol.mjs 是同一套做法。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appJsonPath = path.resolve(here, "../app.json");
const dest = path.resolve(here, "../src/version.ts");

const cfg = JSON.parse(fs.readFileSync(appJsonPath, "utf8")).expo;
const versionCode = cfg?.android?.versionCode;
const versionName = cfg?.version;

if (!Number.isInteger(versionCode) || versionCode < 1) {
  throw new Error(
    `mobile/app.json 的 expo.android.versionCode 必须是 >=1 的整数,现在是 ${JSON.stringify(versionCode)}`,
  );
}
if (typeof versionName !== "string" || !versionName) {
  throw new Error("mobile/app.json 的 expo.version 缺失");
}

const body = `// 由 mobile/scripts/sync-version.mjs 从 mobile/app.json 生成,请勿手改。
//
// versionCode 是**比较更新时的唯一依据**(整数、单调递增):服务端给的比它大才提示更新。
// versionName 只用来显示。
//
// ⚠️ 别改成运行时读取。这个文件是构建那刻的快照,跟着 APK 一起被打进包里 ——
// 换成运行时读会让"我是什么版本"变成一个可能失败、也可能读到旧值的调用。

export const versionName = ${JSON.stringify(versionName)};
export const versionCode = ${versionCode};
`;

fs.writeFileSync(dest, body, "utf8");
console.log(`已生成 src/version.ts —— ${versionName} (versionCode ${versionCode})`);
