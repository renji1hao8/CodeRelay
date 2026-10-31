/**
 * 会话列表那套**目录树分组**的真值用例。
 *
 * ## 为什么值得单独一个脚本
 *
 * 它 2026-09-28 从 `SessionsScreen.tsx` 里抽成了 `sessionTree.ts`,给 Claude 与 Codex
 * **两条列表共用**。于是"抽的时候弄错了一点什么"的后果是**两页一起错** ——
 * 而错的形态都是"看着差不多、只是不太对":缩进差一级、折叠了但计数还在涨、
 * 子目录跑到根上跟父目录平起平坐。这类毛病不盯着看发现不了。
 *
 * 它是纯函数(只 import 了一个没有任何依赖的 `theme.ts`),几毫秒就能跑完。
 *
 * 用法:`node mobile/scripts/check-codex-tree.mjs`(退出码即结论)
 */
import assert from "node:assert/strict";
import { buildGroups, indentOf, isUnder, INDENT, UNKNOWN_DIR } from "../src/sessionTree.ts";

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 造一条"会话":只需要两个字段 —— 分组只看目录与时间 */
const at = (dir, t) => ({ dir, t });
const dirOf = (x) => x.dir;
const timeOf = (x) => x.t;

const groups = (items, collapsed = []) => buildGroups(items, dirOf, timeOf, new Set(collapsed));

// ---------------------------------------------------------------- isUnder

test("isUnder:下一级才算,前缀相同但不是一个目录不算", () => {
  assert.equal(isUnder("E:\\a\\b", "E:\\a"), true);
  assert.equal(isUnder("E:\\a\\b", "E:\\ab"), false, "E:\\ab 不是 E:\\a 的子目录");
  assert.equal(isUnder("E:\\a", "E:\\a"), false, "自己不算自己的子目录");
  assert.equal(isUnder("E:\\a", "E:\\a\\b"), false, "反过来不算");
});

test("isUnder:大小写不敏感(Windows 路径)", () => {
  assert.equal(isUnder("e:\\A\\b", "E:\\a"), true);
});

test("isUnder:分隔符**混着写**配不上 —— 这是搬过来的既有行为,不是新引入的", () => {
  // ⚠️ 这一条钉的是"现状",不是"应该"。同一种分隔符两种写法都行:
  assert.equal(isUnder("E:/a/b", "E:/a"), true);
  assert.equal(isUnder("E:\\a\\b", "E:\\a"), true);
  // 但混着写就配不上 —— 于是它们会被当成两个平级的根。
  // 要合并得同时归一分隔符与盘符大小写,那会改变 Claude 那条列表的表现(见 sessionTree.ts
  // 的说明)。真要做那件事时,改这里 + 改 isUnder 一起。
  assert.equal(isUnder("E:/a/b", "E:\\a"), false);
  assert.equal(isUnder("E:\\a\\b", "E:/a"), false);
});

// ---------------------------------------------------------------- 树形挂载

test("子目录挂在父目录下面,而不是平起平坐", () => {
  const out = groups([at("E:\\a", "2026-01-02T00:00:00Z"), at("E:\\a\\b", "2026-01-01T00:00:00Z")]);
  assert.deepEqual(
    out.map((g) => [g.path, g.depth]),
    [
      ["E:\\a", 0],
      ["E:\\a\\b", 1],
    ],
  );
});

test("子目录的 label 只留尾段(父路径已经在上面一行了)", () => {
  const out = groups([at("E:\\a", null), at("E:\\a\\b", null)]);
  assert.equal(out[0].label, "E:\\a", "根显示全路径");
  assert.equal(out[1].label, "b", "子目录只显示相对父目录的尾段");
});

test("⚠️ 只认列表里出现过的目录:没有祖先在场时它就是根", () => {
  // 这条错了的话 E:\ditie\...\demo 会被挂到一个不存在的 E:\ditie 节点上
  const out = groups([at("E:\\x\\y\\z", null)]);
  assert.deepEqual(out.map((g) => [g.path, g.depth, g.label]), [["E:\\x\\y\\z", 0, "E:\\x\\y\\z"]]);
});

test("挂的是**最长的**那个祖先,不是碰上的第一个", () => {
  const out = groups([
    at("E:\\a", "2026-01-03T00:00:00Z"),
    at("E:\\a\\b", "2026-01-02T00:00:00Z"),
    at("E:\\a\\b\\c", "2026-01-01T00:00:00Z"),
  ]);
  assert.deepEqual(
    out.map((g) => [g.path, g.depth]),
    [
      ["E:\\a", 0],
      ["E:\\a\\b", 1],
      ["E:\\a\\b\\c", 2],
    ],
  );
});

test("同级目录按**里面最新那条**的时间倒序", () => {
  const out = groups([
    at("E:\\old", "2026-01-01T00:00:00Z"),
    at("E:\\new", "2026-06-01T00:00:00Z"),
  ]);
  assert.deepEqual(out.map((g) => g.path), ["E:\\new", "E:\\old"]);
});

test("没有时间的条目不参与排序、也不炸(NaN 那一路)", () => {
  const out = groups([at("E:\\a", null), at("E:\\b", "2026-01-01T00:00:00Z")]);
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "E:\\b", "有时间的排在没时间的前面");
});

// ---------------------------------------------------------------- 计数

test("count 含子树(折叠起来也要能看出来底下有多少东西)", () => {
  const out = groups([
    at("E:\\a", null),
    at("E:\\a", null),
    at("E:\\a\\b", null),
  ]);
  const root = out.find((g) => g.path === "E:\\a");
  assert.equal(root.count, 3);
  const child = out.find((g) => g.path === "E:\\a\\b");
  assert.equal(child.count, 1);
});

// ---------------------------------------------------------------- 折叠

test("折叠 = 本级 data 清空 + 整棵子树不出现", () => {
  const items = [at("E:\\a", null), at("E:\\a", null), at("E:\\a\\b", null)];
  const open = groups(items);
  assert.equal(open.find((g) => g.path === "E:\\a").data.length, 2);

  const shut = groups(items, ["E:\\a"]);
  assert.deepEqual(shut.map((g) => g.path), ["E:\\a"], "折叠后子树整个不出现");
  assert.equal(shut[0].data.length, 0);
  assert.equal(shut[0].count, 3, "⚠️ 折叠了但计数不变 —— 折叠不等于没有");
});

test("折叠父目录时,孙目录也一起收起来", () => {
  const items = [at("E:\\a", null), at("E:\\a\\b", null), at("E:\\a\\b\\c", null)];
  assert.deepEqual(groups(items, ["E:\\a"]).map((g) => g.path), ["E:\\a"]);
});

// ---------------------------------------------------------------- 未知目录

test("没有目录的会话会归到「未知目录」那一组,而不是被丢掉", () => {
  const out = groups([at(null, null), at("", null)]);
  assert.deepEqual(out.map((g) => g.path), [UNKNOWN_DIR]);
  assert.equal(out[0].data.length, 2, "null 与空串都归到这里");
});

// ---------------------------------------------------------------- 空输入

test("空列表给空数组(不是 undefined)", () => {
  assert.deepEqual(groups([]), []);
});

// ---------------------------------------------------------------- 缩进算式

test("缩进只跟层级走,而且层级越深越大", () => {
  assert.equal(indentOf(1) - indentOf(0), INDENT);
  assert.equal(indentOf(3) - indentOf(2), INDENT);
  assert.ok(indentOf(0) > 0, "第 0 级也要留出左边距");
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
