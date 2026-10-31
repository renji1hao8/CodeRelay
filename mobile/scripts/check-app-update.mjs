/**
 * `appUpdate.ts` 的真值用例 —— App 自更新的"要不要提示"判据。
 *
 * 为什么值得单独一个脚本:这段逻辑错了的表现是**手机上永远不提示更新**,或者
 * **每次都提示同一个更新** —— 两种都要真编包、装机、点一下才看得见。而它其实只是
 * 一个纯函数,几毫秒就能判定。
 *
 * ⚠️ 其中一条是**回归用例**:判据必须是 `versionCode`(整数),不是 `versionName`
 * 字符串 —— `"0.10.0" < "0.9.0"` 按字典序成立,拿名字比会让"升到 0.10"之后再无更新。
 *
 * 用法:`node mobile/scripts/check-app-update.mjs`(退出码即结论)
 */
import assert from "node:assert/strict";
import { decideUpdate } from "../src/appUpdate.ts";

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 造一个"服务端回的"版本对象 */
const release = (versionCode, extra = {}) => ({
  versionCode,
  versionName: "1.0.0",
  sha256: "a".repeat(64),
  sizeBytes: 45 * 1024 * 1024,
  notes: null,
  publishedAt: "2026-09-27T00:00:00.000Z",
  ...extra,
});

// ---------------------------------------------------------------- 用例

test("服务端更大 → 提示更新", () => {
  const d = decideUpdate(301, release(302));
  assert.equal(d.kind, "offer");
  assert.equal(d.release.versionCode, 302);
});

test("相等 → 静默(同一个包重发过而已)", () => {
  assert.equal(decideUpdate(301, release(301)).kind, "latest");
});

test("服务端更小 → 静默(这是降级,不该提示)", () => {
  assert.equal(decideUpdate(301, release(300)).kind, "latest");
  assert.equal(decideUpdate(301, release(1)).kind, "latest");
});

test("⚠️ 回归:比的是 versionCode,不是 versionName 字符串", () => {
  // 本地名字排在后面(`0.10.0` 按字典序 > `0.9.9`),但版本号更小 ——
  // 拿名字比就会得出"已是最新",从此再也收不到更新。
  const d = decideUpdate(302, release(303, { versionName: "0.9.9" }));
  assert.equal(d.kind, "offer", "版本号更大就该提示,名字怎么排都不算数");
  assert.equal(d.release.versionName, "0.9.9", "名字只用于显示,原样带出来");
});

test("本地 versionCode 是 0 → 报不正常,而不是提示更新", () => {
  // 读到 0 说明这份包没把版本号带进去(生成 src/version.ts 那步断了)。
  // 当成"有新版本"的话,表现就是**每次都提示更新且装完还是提示**。
  const d = decideUpdate(0, release(302));
  assert.equal(d.kind, "invalid");
  assert.match(d.reason, /本机/);
});

test("本地 versionCode 是 NaN → 报不正常", () => {
  assert.equal(decideUpdate(Number.NaN, release(302)).kind, "invalid");
});

test("服务端 versionCode 缺失 / 不是正整数 → 报不正常", () => {
  for (const bad of [undefined, null, 0, -1, 1.5, "302", Number.NaN]) {
    const d = decideUpdate(301, release(bad));
    assert.equal(d.kind, "invalid", `versionCode=${JSON.stringify(bad)} 该被拒`);
  }
});

test("整个响应不是对象 → 报不正常(别把字符串当版本)", () => {
  for (const bad of [null, undefined, "302", 302, []]) {
    assert.equal(decideUpdate(301, bad).kind, "invalid", `${JSON.stringify(bad)} 该被拒`);
  }
});

test("offer 的字段被规整过 —— 界面拿到的不会是 undefined", () => {
  const d = decideUpdate(301, { versionCode: 302 });
  assert.equal(d.kind, "offer");
  assert.equal(d.release.versionName, "", "缺名字给空串,不是 undefined");
  assert.equal(d.release.notes, null);
  assert.equal(d.release.sha256, "");
  assert.equal(d.release.sizeBytes, 0, "体积畸形时给 0,免得界面上显示 NaN MB");
  assert.equal(d.release.publishedAt, "");
});

test("notes 是空串时按 null 处理", () => {
  const d = decideUpdate(301, release(302, { notes: "" }));
  assert.equal(d.kind, "offer");
  assert.equal(d.release.notes, null, "空串和没有一样,别让界面多画一个空行");
});

test("sizeBytes 是 NaN / 字符串时归 0", () => {
  for (const bad of [Number.NaN, "45MB", null]) {
    const d = decideUpdate(301, release(302, { sizeBytes: bad }));
    assert.equal(d.kind, "offer");
    assert.equal(d.release.sizeBytes, 0, `${JSON.stringify(bad)} 该归 0`);
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
