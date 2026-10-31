/**
 * `toolIntent.ts::nestedShellOf` 的真值用例。
 *
 * 为什么值得单独一个脚本:这段是**从命令文本里猜"这次跑的哪个 shell"**,而猜错的
 * 代价是卡片上挂一个错的角标 —— 那要重装 APK、上真机、翻到那张卡片才看得见。
 * 这里把真实出现过的写法(以及两次误报)摆出来跑,几毫秒就能判定。
 *
 * ⚠️ 两类用例都不能少:
 *   - **误报**(`bash x.sh`、`git commit -m "fix pwsh"`)—— 使用者 2026-09-20 亲自
 *     报过一个:`bash scripts/build-android-apk.sh` 被标成「嵌套 bash」,而那就是外层
 *     同一个 Git Bash
 *   - **漏报**(`& "C:\Program Files\...\pwsh.exe"`)—— 7 装在有空格的路由下,模型
 *     常常带引号写全路径,而原来的 `split(/\s+/)[0]` 一个都认不出
 *
 * 用法:`node mobile/scripts/check-nested-shell.mjs`(退出码即结论)
 */
import assert from "node:assert/strict";
import { nestedShellOf, toolIntent } from "../src/toolIntent.ts";

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);
test("描述与实际命令分开保留，卡片摘要不丢 description", () => {
  const intent = toolIntent("Bash", { command: "npm test", description: "检查修改是否影响原有功能" });
  assert.equal(intent.description, "检查修改是否影响原有功能"); assert.equal(intent.detail, "npm test");
  assert.equal(toolIntent("command", { command: "npm test", justification: "运行验证" }).description, "运行验证");
});

const is = (cmd, want) => test(`「${cmd}」 → ${want ?? "不标"}`, () => {
  assert.equal(nestedShellOf(cmd), want);
});

// ---------------------------------------------------------------- 不该标的
// 同一个 Git Bash,标了只有噪音(使用者报的那次)
is("bash scripts/build-android-apk.sh", null);
is("cd /e/RemoteCC && bash scripts/x.sh", null);
is("sh -c 'ls -la'", null);
is("E:/RemoteCC/scripts/build.sh", null);

// 命令文本里出现 shell 名字 ≠ 在调它
is('git commit -m "fix pwsh"', null);
is('python -c "import os; sh = 1"', null);
is("npm ls | grep pwsh", null);
is("cat powershell.exe.log", null);
is("cd E:\\RemoteCC", null);
is("echo hello", null);

// ---------------------------------------------------------------- 该标的
is("pwsh -NoProfile -Command \"Get-ChildItem\"", "PowerShell 7");
is("powershell -NoProfile -ExecutionPolicy Bypass -File E:\\x.ps1", "PowerShell 5.1");
is("cmd /c dir", "cmd");
is("wsl.exe -d Ubuntu -- bash -lc 'ls'", "WSL");
is("npm run build && pwsh -c 'x'", "PowerShell 7");
is("cd E:/x\npwsh -File y.ps1", "PowerShell 7");

// 带引号 / 带 & 的完整路径 —— 7 装在 WindowsApps 下,路径带空格,模型常常这么写
is(
  '& "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe" -Command x',
  "PowerShell 7",
);
is(
  '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -File x.ps1',
  "PowerShell 5.1",
);
is('& "C:\\Windows\\System32\\cmd.exe" /c dir', "cmd");

// WSL 里那层 bash 不该把结果改成"bash"(只报第一个认出的)
is("wsl bash -lc 'uname -a'", "WSL");

// ---------------------------------------------------------------- 跑

for (const [name, fn] of cases) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`✗ ${name}\n  ${err.message}`);
  }
}

const failed = cases.length - passed;
console.log(`${passed}/${cases.length} 通过${failed ? `,${failed} 个失败` : ""}`);
process.exitCode = failed ? 1 : 0;
