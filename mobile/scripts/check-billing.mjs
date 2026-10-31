/**
 * `billing.ts` 的真值用例。
 *
 * 为什么值得单独一个脚本:这段逻辑错了**不报错、不崩**,只是数字不对 —— 而"今天花了
 * 6.65 还是 9.3"要装一次 APK、上真机看半天才可能发现。这里几毫秒就能判定。
 *
 * 用法:`node mobile/scripts/check-billing.mjs`(退出码即结论)
 */
import assert from "node:assert/strict";
import { computeBill, dateKey, formatCost, inWindow, parseWindows, ruleFor, since } from "../src/billing.ts";

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 造一条用量(时间用**本地时间**构造,免得测试跟着机器时区飘) */
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0).toISOString();
const row = (ts, model, u) => ({
  ts,
  model,
  input: u.input ?? 0,
  output: u.output ?? 0,
  cacheRead: u.cacheRead ?? 0,
  cacheWrite: u.cacheWrite ?? 0,
});
/** 挪到最近的某个星期几(0=周日 … 6=周六)再取 —— 免得用例依赖"某天恰好是周几" */
const onWeekday = (y, mo, d, weekday, h, mi) => {
  const t = new Date(y, mo - 1, d, h, mi, 0);
  while (t.getDay() !== weekday) t.setDate(t.getDate() + 1);
  return t;
};

const rule = (o) => ({
  id: o.id ?? o.model,
  model: o.model,
  // ⚠️ 可选维度必须**透传**:漏一个,用例里那条规则就会变成"每天、每个节假日都生效",
  // 而用例照样绿 —— 等于没测(我第一次就是这么漏掉 days / skipHolidays 的)
  days: o.days,
  skipHolidays: o.skipHolidays,
  // 老用例写 from/to,新用例直接给 windows —— 都映射到 windows 上
  windows: o.windows ?? (o.from && o.to ? `${o.from}-${o.to}` : undefined),
  input: o.input ?? 0,
  cacheRead: o.cacheRead ?? 0,
  output: o.output ?? 0,
});

// ---------------------------------------------------------------- 用例

test("三档都算:未命中输入 / 命中输入 / 输出", () => {
  const rules = [rule({ model: "m1", input: 2, cacheRead: 0.2, output: 8 })];
  const rows = [
    row(at(2026, 9, 19, 10, 0), "m1", {
      input: 1_000_000,
      output: 500_000,
      cacheRead: 2_000_000,
    }),
  ];
  // 未命中 2×1 + 命中 0.2×2 + 输出 8×0.5 = 2 + 0.4 + 4
  assert.equal(Number(computeBill(rows, rules).cost.toFixed(4)), 6.4);
});

test("缓存创建并进未命中那一档(上游价目表里没有单收这一项)", () => {
  const rules = [rule({ model: "m1", input: 2, cacheRead: 0.02 })];
  const withWrite = computeBill(
    [row(at(2026, 9, 19, 10, 0), "m1", { cacheWrite: 1_000_000 })],
    rules,
  );
  const asMiss = computeBill([row(at(2026, 9, 19, 10, 0), "m1", { input: 1_000_000 })], rules);
  assert.equal(withWrite.cost, asMiss.cost, "缓存写 1M 应当和未命中 1M 一个价");
  assert.equal(withWrite.cost, 2);
});

test("峰谷:同一模型两条时段规则,按每条用量自己的时间落价", () => {
  const rules = [
    rule({ model: "m1", from: "08:00", to: "20:00", input: 4 }),
    rule({ model: "m1", from: "20:00", to: "08:00", input: 2 }), // 跨天
  ];
  const one = (h, mi) => computeBill([row(at(2026, 9, 19, h, mi), "m1", { input: 1_000_000 })], rules).cost;

  assert.equal(one(10, 0), 4, "白天走峰时价");
  assert.equal(one(22, 30), 2, "晚上走谷时价");
  assert.equal(one(3, 0), 2, "跨天之后仍然是谷时");
  assert.equal(one(19, 59), 4, "峰时最后一分钟");
  assert.equal(one(20, 0), 2, "20:00 整点已经算谷时(区间是左闭右开)");
});

test("起止重合的规则当全天,不当成零长度窗口", () => {
  const r = rule({ model: "m1", from: "00:00", to: "00:00", input: 1 });
  assert.equal(inWindow(r, new Date(2026, 8, 19, 13, 0)), true);
});

test("精确匹配模型优先于 `*` 兜底", () => {
  const rules = [rule({ model: "*", input: 1 }), rule({ model: "m1", input: 9 })];
  assert.equal(computeBill([row(at(2026, 9, 19, 10, 0), "m1", { input: 1_000_000 })], rules).cost, 9);
  assert.equal(computeBill([row(at(2026, 9, 19, 10, 0), "m2", { input: 1_000_000 })], rules).cost, 1);
});

test("没配到价的用量:不计钱,但**要单独露出来**", () => {
  const rules = [rule({ model: "m1", input: 1 })];
  const rows = [
    row(at(2026, 9, 19, 10, 0), "m1", { input: 1_000_000 }),
    row(at(2026, 9, 19, 10, 1), "m2", { input: 500, output: 500 }),
  ];
  const bill = computeBill(rows, rules);
  assert.equal(bill.cost, 1, "只算配了价的那条");
  assert.equal(bill.priced, 1);
  assert.equal(bill.unpricedRows, 1);
  assert.equal(bill.unpricedTokens, 1000, "漏掉的量要报出来,否则表现只是'总额偏小'");
});

test("全 0 的条目(CLI 占位)不该算进「没配到价」的计数", () => {
  const rows = [row(at(2026, 9, 19, 10, 0), "<synthetic>", {})];
  const bill = computeBill(rows, [rule({ model: "m1", input: 1 })]);
  assert.equal(bill.unpricedRows, 0, "它不花钱,也不该冒出一句「有 1 条没配到价」");
  assert.equal(bill.cost, 0);
});

test("模型名取不到(null)时只能靠 `*` 兜底", () => {
  const noRules = computeBill([row(at(2026, 9, 19, 10, 0), null, { input: 1_000_000 })], []);
  assert.equal(noRules.unpricedRows, 1);
  const star = computeBill([row(at(2026, 9, 19, 10, 0), null, { input: 1_000_000 })], [rule({ model: "*", input: 3 })]);
  assert.equal(star.cost, 3);
});

test("工作日高峰:周末那两段不该按高峰算", () => {
  // 工作日的 9:00–12:00 与 14:00–18:00 是高峰,其余(含周末全天)走全天兜底
  const rules = [
    // ⚠️ 一段规则里写**两段**时段:上游的高峰一天就是两段(9–12、14–18)。只给一对起止
    // 就得配两条规则,而每多一条规则就多一个改价时漏掉的地方
    rule({ id: "peak", model: "m1", days: [1, 2, 3, 4, 5], windows: "09:00-12:00, 14:00-18:00", input: 2 }),
    rule({ id: "idle", model: "m1", input: 1 }),
  ];
  const cost = (dt) => computeBill([row(dt.toISOString(), "m1", { input: 1_000_000 })], rules).cost;

  assert.equal(cost(onWeekday(2026, 9, 19, 1, 10, 0)), 2, "周一的 10:00 是高峰");
  assert.equal(cost(onWeekday(2026, 9, 19, 1, 13, 0)), 1, "周一的 13:00 是空闲(两段之间)");
  assert.equal(cost(onWeekday(2026, 9, 19, 1, 15, 0)), 2, "周一的 15:00 是高峰");
  assert.equal(cost(onWeekday(2026, 9, 19, 1, 19, 0)), 1, "周一的 19:00 是空闲");
  assert.equal(cost(onWeekday(2026, 9, 19, 6, 10, 0)), 1, "周六上午也是空闲");
});

test("法定节假日:标了 skipHolidays 的高峰规则当天不生效", () => {
  const rules = [
    rule({ id: "peak", model: "m1", days: [1, 2, 3, 4, 5], skipHolidays: true, from: "09:00", to: "12:00", input: 2 }),
    rule({ id: "idle", model: "m1", input: 1 }),
  ];
  const workday = onWeekday(2026, 9, 19, 3, 10, 0);
  const key = dateKey(workday);

  assert.equal(
    computeBill([row(workday.toISOString(), "m1", { input: 1_000_000 })], rules).cost,
    2,
    "普通工作日走高峰",
  );
  assert.equal(
    computeBill([row(workday.toISOString(), "m1", { input: 1_000_000 })], rules, [key]).cost,
    1,
    "同一天、同一个时刻,进了节假日名单就按空闲算",
  );
});

test("一个规则可以挂多个模型名(用逗号隔开)", () => {
  const rules = [rule({ model: "deepseek-flash, deepseek-v4-flash", input: 2 })];
  const one = (m) => computeBill([row(at(2026, 9, 19, 10, 0), m, { input: 1_000_000 })], rules).cost;
  assert.equal(one("deepseek-flash"), 2, "新名字");
  assert.equal(one("deepseek-v4-flash"), 2, "旧名字同价 —— 上游说明里写着旧名仍按 Flash 计费");
  assert.equal(one("deepseek-v4-pro"), 0, "没列进去的名字不该被这套价命中");
});

test("时段写法:全角分隔符也认,乱写要能被拦住", () => {
  assert.equal(parseWindows("").length, 0, "留空 = 全天");
  assert.equal(parseWindows("09:00-12:00").length, 1);
  assert.equal(parseWindows("09:00-12:00, 14:00-18:00").length, 2);
  assert.equal(parseWindows("09:00–12:00").length, 1, "从文档粘过来常常是全角破折号");
  assert.equal(parseWindows("9:00-12:00").length, 1, "一位数的小时也认");
  assert.equal(parseWindows("早上九点"), null, "看不懂就返回 null,由校验拦住,绝不能当成全天");
  assert.equal(parseWindows("25:00-26:00"), null);
});

test("有时段的规则优先于全天兜底 —— 别让列表顺序决定价钱", () => {
  // 兜底那条写在**前面**:要是"先配到的先用",这里就会错
  const rules = [
    rule({ id: "idle", model: "m1", input: 1 }),
    rule({ id: "peak", model: "m1", from: "09:00", to: "12:00", input: 2 }),
  ];
  const at10 = onWeekday(2026, 9, 19, 1, 10, 0).toISOString();
  assert.equal(computeBill([row(at10, "m1", { input: 1_000_000 })], rules).cost, 2);
});

test("时间戳坏掉的条目跳过,别把 NaN 传染给总额", () => {
  const rows = [row("这不是时间", "m1", { input: 1_000_000 })];
  const bill = computeBill(rows, [rule({ model: "m1", input: 5 })]);
  assert.equal(bill.cost, 0);
  assert.equal(bill.priced, 0);
});

test("切窗:今日 / 近一小时都靠它", () => {
  const rows = [
    row(at(2026, 9, 19, 23, 50), "m1", { input: 1 }),
    row(at(2026, 9, 20, 0, 10), "m1", { input: 1 }),
  ];
  const midnight = new Date(2026, 8, 20, 0, 0).getTime();
  assert.equal(since(rows, midnight).length, 1, "今日零点之后只剩一条");
  assert.equal(since(rows, new Date(2026, 8, 19, 23, 0).getTime()).length, 2, "近一小时能跨昨天");
});

test("金额显示:极小金额不显示成 ¥0.00", () => {
  assert.equal(formatCost(0), "¥0.00");
  assert.equal(formatCost(0.002), "<¥0.01");
  assert.equal(formatCost(12.345), "¥12.35");
});

test("看不懂的时段写法:不命中任何时刻(而不是静默当成全天)", () => {
  /**
   * ⚠️ 这条判据**改过**,别改回去。
   *
   * 旧行为是"看不懂就当成没有时段",也就是**全天** —— 那意味着一个手打错的时段会
   * 静默按这个价算一整天,而没人看得出来(账单只是数字不对)。现在返回 null:
   * 那条规则不命中任何时刻,用量会落到兜底规则或直接算"没配到价"(界面上会报出来)。
   * 保存前的校验也会拦住这种情况,所以正常路径上根本存不进去。
   */
  const r = rule({ model: "m1", windows: "25:99-99:99", input: 1 });
  assert.equal(inWindow(r, new Date(2026, 8, 19, 10, 0)), false);
  assert.equal(ruleFor("m1", new Date(2026, 8, 19, 10, 0), [r]), null);
});

/**
 * 「没配到价」要说出**缺口在哪**。
 *
 * ⚠️ 这条是 2026-09-21 那条报障的直接产物:使用者的低价规则把星期配成了「六日」,
 * 于是工作日有 17 小时没有任何规则覆盖,而当天的量全落在那些小时里 —— 账单显示 ¥0.00,
 * 而界面只说了"有 N 条没配到价",没有任何线索指向"缺口在时间上"。
 * 所以 `computeBill` 现在要把最集中的几处归堆报出来(见 UnpricedSlot)。
 */
test("没配到价时,报出缺口集中在哪个模型/星期/小时", () => {
  const rules = [rule({ model: "deepseek-flash", days: [1, 2, 3, 4, 5], windows: "09:00-12:00", input: 1 })];
  // 周一凌晨 3 点 —— 那条规则只盖 09:00-12:00,所以这一段必然没配到价
  const mon3 = onWeekday(2026, 9, 1, 1, 3, 0); // 周一 03:00
  const rows = [row(mon3.toISOString(), "deepseek-flash", { input: 100, output: 10 })];
  const bill = computeBill(rows, rules);
  assert.equal(bill.unpricedRows, 1);
  assert.equal(bill.unpricedSlots.length, 1);
  assert.equal(bill.unpricedSlots[0].label, "deepseek-flash 周一 03 时");
  assert.equal(bill.unpricedSlots[0].rows, 1);
  assert.equal(bill.unpricedSlots[0].tokens, 110);
});

test("缺口按条数倒序,而且最多只报 3 处", () => {
  const rules = [rule({ model: "deepseek-flash", days: [1, 2, 3, 4, 5], windows: "09:00-12:00", input: 1 })];
  const base = onWeekday(2026, 9, 1, 1, 0, 0); // 周一 00:00
  const rows = [];
  // 4 个不同的小时,条数分别是 1 / 2 / 3 / 4
  for (let h = 0; h < 4; h++) {
    for (let n = 0; n <= h; n++) {
      const t = new Date(base);
      t.setHours(h, 0, 0, 0);
      rows.push(row(t.toISOString(), "deepseek-flash", { input: 1 }));
    }
  }
  const bill = computeBill(rows, rules);
  assert.equal(bill.unpricedRows, 10);
  assert.equal(bill.unpricedSlots.length, 3, "最多 3 处 —— 这一行是「指出缺口」,不是列清单");
  assert.deepEqual(
    bill.unpricedSlots.map((x) => x.rows),
    [4, 3, 2],
    "按条数倒序",
  );
  assert.equal(bill.unpricedSlots[0].label, "deepseek-flash 周一 03 时");
});

test("配了全天兜底之后,同一批用量就都有价了(而且高峰仍然走高峰价)", () => {
  const peak = rule({ model: "deepseek-flash", days: [1, 2, 3, 4, 5], windows: "09:00-12:00", input: 2 });
  const base = rule({ model: "deepseek-flash", input: 1 }); // 星期不选、时段留空 = 每天全天
  const morning = onWeekday(2026, 9, 1, 1, 10, 0); // 周一 10:00,落在高峰里
  const night = onWeekday(2026, 9, 1, 1, 3, 0); // 周一 03:00,高峰之外
  const bill = computeBill(
    [row(morning.toISOString(), "deepseek-flash", { input: 1e6 }), row(night.toISOString(), "deepseek-flash", { input: 1e6 })],
    [peak, base],
  );
  assert.equal(bill.unpricedRows, 0);
  assert.equal(bill.unpricedSlots.length, 0);
  assert.equal(bill.cost, 2 + 1, "高峰 2 元 + 兜底 1 元 —— 有时段的优先,兜底只接没人要的");
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
