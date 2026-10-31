/**
 * `codexQuota.ts` 的真值用例 —— Codex 额度那些**时间换算**。
 *
 * 为什么值得单独一个脚本:这里唯一会错的就是时间(unix 秒 vs 毫秒、跨小时跨天、
 * 「已重置」的边界),而算错了的表现只是**倒计时不对** —— 要真编包、装机、盯着看
 * 才发现。它其实全是纯函数,几毫秒就能判定。
 *
 * ⚠️ 其中一条是**回归用例**:`resetsAt` 是 **unix 秒**,不是毫秒。当成毫秒算的话,
 * 差值会是个巨大的负数,于是**每个窗口都显示「已重置」** —— 看起来"挺合理",其实全错。
 *
 * 用法:`node mobile/scripts/check-codex-quota.mjs`(退出码即结论)
 */
import assert from "node:assert/strict";
import { buildQuotaView, describeAge, describeReset, describeWindow, windowLabel } from "../src/codexQuota.ts";

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 固定一个"现在",让用例可重复 */
const NOW_MS = Date.parse("2026-09-27T12:00:00.000Z");
const NOW_SEC = Math.floor(NOW_MS / 1000);

const win = (usedPercent, windowMinutes = 300, resetsAt = NOW_SEC + 3600) => ({
  usedPercent,
  windowMinutes,
  resetsAt,
});

// ---------------------------------------------------------------- 窗口名

test("窗口名从时长推,不写死 primary/secondary", () => {
  assert.equal(windowLabel(300), "5 小时窗口");
  assert.equal(windowLabel(10080), "7 天窗口");
  assert.equal(windowLabel(1440), "1 天窗口");
  assert.equal(windowLabel(60), "1 小时窗口");
  assert.equal(windowLabel(90), "90 分钟窗口");
});

test("时长取不到 → 一个中性的名字,而不是空串或 NaN", () => {
  assert.equal(windowLabel(null), "额度窗口");
  assert.equal(windowLabel(0), "额度窗口");
  assert.equal(windowLabel(-5), "额度窗口");
  assert.equal(windowLabel(Number.NaN), "额度窗口");
});

// ---------------------------------------------------------------- 倒计时

test("⚠️ 回归:resetsAt 是 unix 秒,不是毫秒", () => {
  // 当成毫秒算的话,1 小时后会被算成"很久以前" → 显示「已重置」
  assert.equal(describeReset(NOW_SEC + 3600, NOW_MS), "1 小时后重置");
});

test("已经过了重置点 → 「已重置」(比显示 0 分钟或负数有用)", () => {
  assert.equal(describeReset(NOW_SEC - 1, NOW_MS), "已重置");
  assert.equal(describeReset(NOW_SEC - 86400, NOW_MS), "已重置");
  assert.equal(describeReset(NOW_SEC, NOW_MS), "已重置", "正好到点也算已重置");
});

test("不足一分钟说「不到 1 分钟」,不显示 0", () => {
  assert.equal(describeReset(NOW_SEC + 30, NOW_MS), "不到 1 分钟后重置");
  assert.equal(describeReset(NOW_SEC + 59, NOW_MS), "不到 1 分钟后重置");
});

test("分钟 / 小时 / 天的分档", () => {
  assert.equal(describeReset(NOW_SEC + 120, NOW_MS), "2 分钟后重置");
  assert.equal(describeReset(NOW_SEC + 90 * 60, NOW_MS), "1 小时 30 分后重置");
  assert.equal(describeReset(NOW_SEC + 2 * 3600, NOW_MS), "2 小时后重置", "整点不带零分");
  assert.equal(describeReset(NOW_SEC + 50 * 3600, NOW_MS), "2 天 2 小时后重置");
  assert.equal(describeReset(NOW_SEC + 48 * 3600, NOW_MS), "2 天后重置", "整点不带零小时");
});

test("取不到重置时刻 → 空串(界面别画那一行)", () => {
  assert.equal(describeReset(null, NOW_MS), "");
  assert.equal(describeReset(Number.NaN, NOW_MS), "");
});

// ---------------------------------------------------------------- 一行

test("没有窗口就没有那一行", () => {
  assert.equal(describeWindow(null, NOW_MS), null);
});

test("百分比被夹到 0–100(上游给 150 也不该把进度条画到框外)", () => {
  assert.equal(describeWindow(win(150), NOW_MS).percent, 100);
  assert.equal(describeWindow(win(-5), NOW_MS).percent, 0);
  assert.equal(describeWindow(win(31.6), NOW_MS).percent, 32, "四舍五入");
  assert.equal(describeWindow(win(31), NOW_MS).ratio, 0.31);
});

// ---------------------------------------------------------------- 快照新旧

test("快照有多新 —— 这条必须有,否则数字会被当成此刻的", () => {
  assert.equal(describeAge(new Date(NOW_MS - 30_000).toISOString(), NOW_MS), "刚刚");
  assert.equal(describeAge(new Date(NOW_MS - 5 * 60_000).toISOString(), NOW_MS), "5 分钟前");
  assert.equal(describeAge(new Date(NOW_MS - 3 * 3600_000).toISOString(), NOW_MS), "3 小时前");
  assert.equal(describeAge(new Date(NOW_MS - 2 * 86400_000).toISOString(), NOW_MS), "2 天前");
});

test("时间戳坏掉 → 空串,不是 NaN", () => {
  assert.equal(describeAge("", NOW_MS), "");
  assert.equal(describeAge("不是时间", NOW_MS), "");
});

// ---------------------------------------------------------------- 整份

test("整份:两个窗口都在、套餐大写、余额原样", () => {
  const v = buildQuotaView(
    {
      planType: "plus",
      primary: win(100, 300, NOW_SEC + 7200),
      secondary: win(31, 10080, NOW_SEC + 6 * 86400),
      creditBalance: "28.8974950000",
      blocked: true,
      resetCredits: 1,
      fetchedAt: new Date(NOW_MS - 60_000).toISOString(),
    },
    NOW_MS,
  );
  assert.equal(v.rows.length, 2);
  assert.equal(v.rows[0].label, "5 小时窗口");
  assert.equal(v.rows[0].percent, 100);
  assert.equal(v.rows[0].resetHint, "2 小时后重置");
  assert.equal(v.rows[1].label, "7 天窗口");
  assert.equal(v.plan, "PLUS");
  assert.equal(v.balance, "28.8974950000", "余额必须原样,别转数字");
  assert.equal(v.blocked, true);
  assert.equal(v.resetCredits, 1);
  assert.equal(v.ageHint, "1 分钟前");
});

test("整份:窗口为 null 时那一行直接不出现(不是画一行 0%)", () => {
  const v = buildQuotaView(
    {
      planType: null,
      primary: null,
      secondary: win(31, 10080),
      creditBalance: null,
      blocked: false,
      resetCredits: 0,
      fetchedAt: new Date(NOW_MS).toISOString(),
    },
    NOW_MS,
  );
  assert.equal(v.rows.length, 1);
  assert.equal(v.rows[0].label, "7 天窗口");
  assert.equal(v.plan, "", "没有套餐名就给空串");
  assert.equal(v.balance, null);
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
