// 发版前把 mobile/app.json 的 versionCode +1。
//
// ⚠️ 为什么必须单调递增:安卓靠 versionCode 判"能不能覆盖安装",而 App 自更新靠它判
// "电脑上那个更新是不是比我新"。**忘了 +1 不会报任何错** —— 只是手机上永远弹不出更新,
// 而人只会觉得"自更新坏了"。所以这一步放在构建脚本里自动做,不靠人记得。
//
// 它只改一个数字,输出的 app.json 保持两空格缩进 + 末尾换行。
// ⚠️ 数组(permissions / plugins)会被 JSON.stringify 展开成多行 —— 首次改写会有一次
// 纯格式化的 diff,之后就稳定了;不值得为它写个保格式的解析器。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appJsonPath = path.resolve(here, "../mobile/app.json");

const cfg = JSON.parse(fs.readFileSync(appJsonPath, "utf8"));
const before = cfg?.expo?.android?.versionCode;
if (!Number.isInteger(before) || before < 1) {
  throw new Error(
    `mobile/app.json 的 expo.android.versionCode 必须是 >=1 的整数,现在是 ${JSON.stringify(before)}`,
  );
}
cfg.expo.android.versionCode = before + 1;

fs.writeFileSync(appJsonPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
console.log(`versionCode ${before} → ${before + 1}`);
