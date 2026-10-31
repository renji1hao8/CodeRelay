/**
 * `deepLink.ts` 的真值用例 —— 通知点进来的那条链接怎么解析。
 *
 * 为什么值得单独一个脚本:错了的表现是**通知点不开**(或点开错的会话),
 * 而那要真发一条通知、再在手机上点一下才看得见。判据全在字符串上,几毫秒就能判定。
 *
 * 用法:`node mobile/scripts/check-deep-link.mjs`(退出码即结论)
 */
import assert from "node:assert/strict";
import { parseDeepLink } from "../src/deepLink.ts";

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("Claude:cc 链接", () => {
  assert.deepEqual(parseDeepLink("remotecc://session/cc/41cf11bf-04e7-42b1"), {
    kind: "cc",
    id: "41cf11bf-04e7-42b1",
  });
});

test("Claude:run 链接", () => {
  assert.deepEqual(parseDeepLink("remotecc://session/run/08844e71-fda4"), {
    kind: "run",
    id: "08844e71-fda4",
  });
});

test("Codex 链接 —— 这条是新增的,别漏", () => {
  assert.deepEqual(parseDeepLink("remotecc://session/codex/01a0e2d5-12b5-7fc0"), {
    kind: "codex",
    id: "01a0e2d5-12b5-7fc0",
  });
});

test("没带标签的老链接按 run 处理(它当年的语义)", () => {
  assert.deepEqual(parseDeepLink("remotecc://session/abc123"), { kind: "run", id: "abc123" });
});

test("⚠️ 会话 id 里出现 codex 不会被当成标签", () => {
  // 标签位在 `session/` 之后**紧跟斜杠**才算;一个叫 `codex-abc` 的 id 不该被认成 codex 标签
  assert.deepEqual(parseDeepLink("remotecc://session/codex-abc/xyz"), { kind: "run", id: "codex-abc" });
});

test("多余的尾巴(查询串 / 更深的路径)只取 id", () => {
  assert.deepEqual(parseDeepLink("remotecc://session/cc/abc?x=1"), { kind: "cc", id: "abc" });
  assert.deepEqual(parseDeepLink("remotecc://session/cc/abc/def"), { kind: "cc", id: "abc" });
  assert.deepEqual(parseDeepLink("remotecc://session/codex/abc#frag"), { kind: "codex", id: "abc" });
});

test("不是我们要的链接一律 null(别的 App 的 scheme、home、空)", () => {
  for (const bad of [
    null,
    undefined,
    "",
    "remotecc://home",
    "remotecc://session",
    "remotecc://session/cc",
    "remotecc://session/cc/",
    "https://example.com/session/cc/abc",
    "随便一句话",
  ]) {
    assert.equal(parseDeepLink(bad), null, `${JSON.stringify(bad)} 该被拒`);
  }
});

// ---------------------------------------------------------------- 跑

for (const [name, fn] of cases) {
  try {
    fn();
    passed += 1;
    console.log("  ✓", name);
  } catch (err) {
    console.error("  ✗", name);
    console.error("   ", err.message);
  }
}

console.log(`\n${passed}/${cases.length} 通过`);
process.exitCode = passed === cases.length ? 0 : 1;
