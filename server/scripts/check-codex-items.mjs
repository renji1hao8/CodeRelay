/**
 * `codex/items.ts` 的真值用例 —— Codex 的 item → 我们的块/消息。
 *
 * 为什么值得单独一个脚本:这份映射错了的表现是"某个工具调用没显示"、"多了一堆空行"、
 * 或者"一轮回答碎成十几个气泡" —— 都要真跑一轮 Codex 才看得见(而那要花额度)。
 * 它其实是纯函数,几毫秒就能判定。
 *
 * ⚠️ 其中几条是**照着真数据定的**,不是照着 schema(两者差别很大):
 *   · `reasoning` 在 schema 里有 content/summary,**实际两个都是空** —— 必须跳过,
 *     否则某真实会话 100 条里会多出 45 行空白;
 *   · item **嵌在 `item` 字段下**,不是顶层。
 *
 * 用法:`node server/scripts/check-codex-items.mjs`(退出码即结论)
 */
import assert from "node:assert/strict";
import { blocksOfItem, messagesOfEntries } from "../src/codex/items.ts";

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);
test("Codex 命令卡保留审批说明", () => {
  const blocks = blocksOfItem({ type: "commandExecution", id: "description-test", command: "npm test", reason: "验证修改" });
  assert.equal(blocks[0].input.description, "验证修改");
});

/** 造一条 entry(照 `thread/items/list` 的真实形状:item 嵌在 `item` 里) */
const entry = (item, turnId = "T1", startedAtMs = 1790512000000) => ({ turnId, item, startedAtMs, completedAtMs: startedAtMs + 100 });

const textOf = (blocks) => blocks.filter((b) => b.type === "text").map((b) => b.text).join("");

// ---------------------------------------------------------------- 单个 item

test("userMessage:content 数组里的 text 段拼起来", () => {
  const b = blocksOfItem({ type: "userMessage", id: "u1", content: [{ type: "text", text: "第一行" }, { type: "text", text: "第二行" }] });
  assert.equal(textOf(b), "第一行\n第二行");
});

test("agentMessage / plan → 文本", () => {
  assert.equal(textOf(blocksOfItem({ type: "agentMessage", id: "a1", text: "收到" })), "收到");
  assert.equal(textOf(blocksOfItem({ type: "plan", id: "p1", text: "先读再改" })), "先读再改");
});

test("⚠️ 回归:reasoning 必须**整个跳过**,不能映射成 thinking", () => {
  // 真数据里 summary/content 都是空的(schema 里有字段 ≠ 实际有值)。
  // 映射成 thinking 的话,某真实会话 100 条里会多出 45 行空白。
  assert.deepEqual(blocksOfItem({ type: "reasoning", id: "r1", summary: [], content: [] }), []);
  // 就算将来它真给了文本,也先按噪声跳过 —— 要显示得先改这里并更新这条用例
  assert.deepEqual(blocksOfItem({ type: "reasoning", id: "r1", summary: ["有内容"], content: [] }), []);
});

test("噪声类型一律不显示", () => {
  for (const t of ["sleep", "hookPrompt", "subAgentActivity", "enteredReviewMode"]) {
    assert.deepEqual(blocksOfItem({ type: t, id: "x" }), [], `${t} 该被跳过`);
  }
});

test("⚠️ 认不出来的新类型要**渲染出来**,不能静默丢掉", () => {
  // 静默丢掉的话,Codex 将来加一个新 item 类型时它会凭空消失,而"看不见的缺失"最难发现
  const b = blocksOfItem({ type: "brandNewThing", id: "n1" });
  assert.equal(b.length, 1);
  assert.equal(b[0].type, "tool_use");
  assert.equal(b[0].name, "brandNewThing");
});

test("commandExecution → tool_use + tool_result(命令与输出都在)", () => {
  const b = blocksOfItem({
    type: "commandExecution",
    id: "exec-1",
    command: "ls -la",
    cwd: "E:\\RemoteCC",
    aggregatedOutput: "file1\nfile2",
    exitCode: 0,
    status: "completed",
  });
  assert.equal(b.length, 2);
  assert.equal(b[0].type, "tool_use");
  assert.equal(b[0].name, "command");
  assert.deepEqual(b[0].input, { command: "ls -la", cwd: "E:\\RemoteCC" });
  assert.equal(b[1].type, "tool_result");
  assert.equal(b[1].toolUseId, "exec-1", "结果要认得上一次调用");
  assert.equal(b[1].text, "file1\nfile2");
  assert.equal(b[1].isError, false);
});

test("commandExecution 的失败判据:exitCode 非零 **或** status=failed", () => {
  assert.equal(blocksOfItem({ type: "commandExecution", id: "e", command: "x", exitCode: 1 })[1].isError, true);
  assert.equal(blocksOfItem({ type: "commandExecution", id: "e", command: "x", status: "failed" })[1].isError, true);
  // 两者都缺时当成功 —— 别把"不知道"渲染成"失败了"
  assert.equal(blocksOfItem({ type: "commandExecution", id: "e", command: "x" })[1].isError, false);
});

test("fileChange → tool_use(带 changes) + tool_result(改了哪几个文件)", () => {
  const b = blocksOfItem({
    type: "fileChange",
    id: "fc-1",
    status: "completed",
    changes: [
      { path: "a.md", kind: { type: "add" }, diff: "+1" },
      { path: "b.md", kind: { type: "update" }, diff: "-1" },
    ],
  });
  assert.equal(b[0].name, "apply_patch");
  assert.equal(b[0].input.changes.length, 2, "原文的 changes 要留着,diff 在卡里要显示");
  assert.match(b[1].text, /2 个文件/);
  assert.match(b[1].text, /a\.md/);
});

test("webSearch → 带 query 的 tool_use", () => {
  const b = blocksOfItem({ type: "webSearch", id: "w1", query: "怎么用", results: [{}, {}] });
  assert.equal(b[0].name, "web_search");
  assert.deepEqual(b[0].input, { query: "怎么用" });
  assert.match(b[1].text, /2 条/);
});

test("mcpToolCall 用 tool 名;带 error 时标失败", () => {
  const ok = blocksOfItem({ type: "mcpToolCall", id: "m1", tool: "search_memory", arguments: { q: "x" } });
  assert.equal(ok[0].name, "search_memory");
  assert.equal(ok[1].isError, false);
  const bad = blocksOfItem({ type: "mcpToolCall", id: "m2", tool: "search_memory", error: "超时" });
  assert.equal(bad[1].isError, true);
  assert.equal(bad[1].text, "超时");
});

// ---------------------------------------------------------------- 合并成消息

test("⚠️ 一轮里的多条 assistant item 要并成**一条**消息,不是一堆气泡", () => {
  const msgs = messagesOfEntries([
    entry({ type: "userMessage", id: "u1", content: [{ type: "text", text: "帮我改" }] }),
    entry({ type: "agentMessage", id: "a1", text: "好,我先看看" }),
    entry({ type: "commandExecution", id: "c1", command: "ls", aggregatedOutput: "x" }),
    entry({ type: "agentMessage", id: "a2", text: "改完了" }),
  ]);
  assert.equal(msgs.length, 2, "一条用户 + 一条助手");
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].blocks.length, 4, "助手那条里:文本 + 工具 + 结果 + 文本");
});

test("reasoning 夹在中间时,不影响合并(它整个不出现)", () => {
  const msgs = messagesOfEntries([
    entry({ type: "userMessage", id: "u1", content: [{ type: "text", text: "问" }] }),
    entry({ type: "reasoning", id: "r1", summary: [], content: [] }),
    entry({ type: "agentMessage", id: "a1", text: "答" }),
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].blocks.length, 1);
});

test("连着两条用户消息 → 各起一条(不会被并进助手那条)", () => {
  const msgs = messagesOfEntries([
    entry({ type: "userMessage", id: "u1", content: [{ type: "text", text: "一" }] }),
    entry({ type: "userMessage", id: "u2", content: [{ type: "text", text: "二" }] }),
  ]);
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs.map((m) => m.role), ["user", "user"]);
});

test("助手侧开头(没有前置用户消息)也要能起一条", () => {
  const msgs = messagesOfEntries([entry({ type: "agentMessage", id: "a1", text: "开头就是我" })]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, "assistant");
});

test("消息的 uuid / ts 从 item id 与 startedAtMs 来", () => {
  const msgs = messagesOfEntries([entry({ type: "userMessage", id: "u1", content: [{ type: "text", text: "x" }] }, "T1", 1790512000000)]);
  assert.equal(msgs[0].uuid, "u1");
  assert.equal(msgs[0].ts, new Date(1790512000000).toISOString());
});

test("空 entry / 坏形状不崩", () => {
  assert.deepEqual(messagesOfEntries([]), []);
  assert.deepEqual(messagesOfEntries([null, {}, { item: null }, { item: "字符串" }]), []);
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
