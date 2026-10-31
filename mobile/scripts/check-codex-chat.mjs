/**
 * `codexChat.ts` 的真值用例 —— Codex 的流帧怎么作用到消息列表上。
 *
 * 为什么值得单独一个脚本:这里错了的表现是**一次回答碎成十几个气泡**(该整条替换的
 * 写成了追加),而那要真跑一轮 Codex 才看得见 —— 还要花额度。它是纯函数,几毫秒就能判定。
 *
 * 用法:`node mobile/scripts/check-codex-chat.mjs`(退出码即结论)
 */
import assert from "node:assert/strict";
import {
  applyChatFrame,
  deriveCodexPhase,
  dropApproval,
  emptyChatState,
  mergeReseed,
  prependOlder,
  seedChatState,
  textOfMessage,
  tokensLabel,
  withStreaming,
} from "../src/codexChat.ts";

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const userMsg = (text) => ({ uuid: "u1", role: "user", ts: null, blocks: [{ type: "text", text }] });
const textBlock = (text) => ({ type: "text", text });
const seed = (messages = []) => ({ ...emptyChatState, messages });

const texts = (s) =>
  withStreaming(s)
    .map((m) => m.blocks.filter((b) => b.type === "text").map((b) => b.text).join("|"))
    .join(" ‖ ");

// ---------------------------------------------------------------- 打开

test("用历史铺状态", () => {
  const s = seedChatState({
    thread: { id: "t", name: null, cwd: null, createdAt: null, updatedAt: null, preview: "" },
    messages: [userMsg("你好"), { uuid: "a1", role: "assistant", ts: null, blocks: [textBlock("在")] }],
    truncated: false,
  });
  assert.equal(s.messages.length, 2);
  assert.equal(s.busy, false);
  assert.deepEqual(s.approvals, []);
});

// ---------------------------------------------------------------- 流式

test("state 帧改忙闲", () => {
  assert.equal(applyChatFrame(emptyChatState, { t: "state", busy: true }).busy, true);
  assert.equal(applyChatFrame({ ...emptyChatState, busy: true }, { t: "state", busy: false }).busy, false);
});

test("assistant_delta 是**累加**的", () => {
  let s = applyChatFrame(emptyChatState, { t: "assistant_delta", text: "收" });
  s = applyChatFrame(s, { t: "assistant_delta", text: "到" });
  assert.equal(s.streaming, "收到");
  assert.equal(s.busy, true, "吐字期间该是忙的");
});

test("空 delta 不改变状态(不产生多余渲染)", () => {
  assert.equal(applyChatFrame(emptyChatState, { t: "assistant_delta", text: "" }), emptyChatState);
});

// ---------------------------------------------------------------- 整条替换 vs 追加

test("⚠️ 回归:上一条是助手时,assistant_message 要**整条替换**,不是追加", () => {
  // 服务端每完成一个 item 就发一遍"这条助手消息的全量块" —— 追加的话一次回答会碎成十几个气泡
  const s0 = seed([userMsg("帮我改"), { uuid: "a1", role: "assistant", ts: null, blocks: [textBlock("我先看看")] }]);
  const s1 = applyChatFrame(s0, { t: "assistant_message", blocks: [textBlock("我先看看"), { type: "tool_use", id: "c1", name: "command", input: {} }] });
  assert.equal(s1.messages.length, 2, "条数不该变 —— 变多就是碎成气泡了");
  assert.equal(s1.messages[1].blocks.length, 2, "块被整份换掉");
});

test("上一条是用户时,assistant_message 起一条新的", () => {
  const s = applyChatFrame(seed([userMsg("问")]), { t: "assistant_message", blocks: [textBlock("答")] });
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[1].role, "assistant");
});

test("压根没有消息时也能起一条", () => {
  const s = applyChatFrame(emptyChatState, { t: "assistant_message", blocks: [textBlock("开头就是我")] });
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, "assistant");
});

test("assistant_message 要把 streaming 清掉(那段文本已经在 blocks 里了)", () => {
  let s = applyChatFrame(emptyChatState, { t: "assistant_delta", text: "收到" });
  s = applyChatFrame(s, { t: "assistant_message", blocks: [textBlock("收到")] });
  assert.equal(s.streaming, "", "不清的话同一句话会显示两遍");
  assert.equal(texts(s), "收到", "而且只显示一遍");
});

test("空的 blocks 不动状态", () => {
  assert.equal(applyChatFrame(emptyChatState, { t: "assistant_message", blocks: [] }), emptyChatState);
});

// ---------------------------------------------------------------- 审批

test("permission_request 加一张卡;同一个 reqId 不重复加", () => {
  const frame = { t: "permission_request", reqId: "codex-1", tool: "命令", input: { command: "ls" }, diff: "ls" };
  const s1 = applyChatFrame(emptyChatState, frame);
  assert.equal(s1.approvals.length, 1);
  assert.equal(s1.approvals[0].tool, "命令");
  assert.equal(s1.approvals[0].diff, "ls");
  const s2 = applyChatFrame(s1, frame);
  assert.equal(s2.approvals.length, 1, "重连补发时会重复推同一张 —— 要按 reqId 去重");
});

test("没有 diff 时卡片上就没有那一栏(不是空串)", () => {
  const s = applyChatFrame(emptyChatState, { t: "permission_request", reqId: "r", tool: "命令", input: {} });
  assert.equal("diff" in s.approvals[0], false);
});

test("回答完把卡片去掉", () => {
  const s = applyChatFrame(emptyChatState, { t: "permission_request", reqId: "codex-1", tool: "命令", input: {} });
  assert.equal(dropApproval(s, "codex-1").approvals.length, 0);
  assert.equal(dropApproval(s, "不认识的 id").approvals.length, 1, "不认识的别误删");
});

// ---------------------------------------------------------------- 收尾

test("result 把忙闲与流式都收干净", () => {
  let s = applyChatFrame(emptyChatState, { t: "assistant_delta", text: "半句" });
  s = applyChatFrame(s, { t: "result", subtype: "completed" });
  assert.equal(s.busy, false);
  assert.equal(s.streaming, "", "只回了半句也不能让它永远挂在气泡外面");
});

test("error 记一句话并把忙闲收掉", () => {
  const s = applyChatFrame({ ...emptyChatState, busy: true }, { t: "error", message: "额度用完了", recoverable: true });
  assert.equal(s.error, "额度用完了");
  assert.equal(s.busy, false);
});

test("不认识的帧原样返回(不炸、也不乱改)", () => {
  assert.equal(applyChatFrame(emptyChatState, { t: "mode_changed", mode: "ask" }), emptyChatState);
  assert.equal(applyChatFrame(emptyChatState, { t: "shell_started" }), emptyChatState);
});

// ---------------------------------------------------------------- 渲染用

test("withStreaming:没有流式内容时就是消息本身", () => {
  const s = seed([userMsg("问")]);
  assert.equal(withStreaming(s).length, 1);
});

test("withStreaming:流式那段补成一个尾巴气泡", () => {
  let s = seed([userMsg("问")]);
  s = applyChatFrame(s, { t: "assistant_delta", text: "正在" });
  const view = withStreaming(s);
  assert.equal(view.length, 2);
  assert.equal(view[1].role, "assistant");
  assert.equal(texts(s), "问 ‖ 正在");
});

test("withStreaming:上一条已是助手时并进去,不再起一个", () => {
  let s = seed([userMsg("问"), { uuid: "a1", role: "assistant", ts: null, blocks: [textBlock("前半")] }]);
  s = applyChatFrame(s, { t: "assistant_delta", text: "后半" });
  const view = withStreaming(s);
  assert.equal(view.length, 2, "不该变成三条");
  assert.equal(texts(s), "问 ‖ 前半|后半");
});

// ---------------------------------------------------------------- 重连重读

test("⚠️ 重连重读:刚发出去、服务端还没记下的那句不能被抹掉", () => {
  // 和坑 40 同一类问题 —— 整份替换的话使用者看到的是"我打的字自己没了"
  const local = [userMsg("帮我看一下这个报错")];
  const incoming = [{ uuid: "u0", role: "user", ts: null, blocks: [textBlock("上一句")] }];
  const out = mergeReseed(local, incoming);
  assert.equal(out.length, 2);
  assert.equal(textOfMessage(out[1]), "帮我看一下这个报错");
});

test("重连重读:服务端已经有了那句 → 不重复补", () => {
  const local = [userMsg("你好")];
  const incoming = [userMsg("你好"), { uuid: "a1", role: "assistant", ts: null, blocks: [textBlock("在")] }];
  const out = mergeReseed(local, incoming);
  assert.equal(out.length, 2, "补的话会变成两条一模一样的用户消息");
});

test("重连重读:本地最后一条不是用户消息 → 直接用拉回来的", () => {
  const local = [userMsg("问"), { uuid: "a1", role: "assistant", ts: null, blocks: [textBlock("答")] }];
  const incoming = [userMsg("问")];
  assert.equal(mergeReseed(local, incoming).length, 1);
});

test("重连重读:本地空的 → 直接用拉回来的", () => {
  const incoming = [userMsg("问")];
  assert.equal(mergeReseed([], incoming), incoming);
});

test("重连重读:拉回来的是空的 → 至少保住刚发的那句", () => {
  const local = [userMsg("刚发的")];
  assert.equal(mergeReseed(local, []).length, 1);
});

// ---------------------------------------------------------------- 加载更早

test("加载更早:老一页接在**前面**,顺序不乱", () => {
  const cur = [userMsg("新的")];
  const older = [{ uuid: "o1", role: "user", ts: null, blocks: [textBlock("老的")] }];
  const out = prependOlder(cur, older);
  assert.deepEqual(out.map((m) => textOfMessage(m)), ["老的", "新的"]);
});

test("⚠️ 两页之间重复的那条只留一份(页边界正好切在一串助手条目里时会重)", () => {
  const shared = { uuid: "dup", role: "assistant", ts: null, blocks: [textBlock("跨页那条")] };
  const out = prependOlder([shared, userMsg("新的")], [shared]);
  assert.equal(out.filter((m) => m.uuid === "dup").length, 1);
  assert.deepEqual(out.map((m) => textOfMessage(m)), ["跨页那条", "新的"]);
});

test("本地那条没有 uuid 的回显不会被当重复丢掉", () => {
  // `uuid: null` 的是实时流建出来的(刚发出去那句),它只可能在尾部
  const local = { uuid: null, role: "user", ts: null, blocks: [textBlock("刚发的")] };
  const out = prependOlder([local], [{ uuid: "o1", role: "user", ts: null, blocks: [textBlock("老的")] }]);
  assert.equal(out.length, 2);
  assert.equal(out[out.length - 1], local, "本地那条还在最后");
});

test("到头了(老一页是空)时什么都不变", () => {
  const cur = [userMsg("只有这句")];
  assert.deepEqual(prependOlder(cur, []), cur);
});

// ---------------------------------------------------------------- 状态那一行

test("⚠️ 有审批卡等人点时,说的是「等你批准」而不是「正在跑」", () => {
  // 那时候它其实已经停下来了,说"正在跑"会让人白等
  const s = { ...emptyChatState, busy: true, approvals: [{ reqId: "r", tool: "命令", input: {} }] };
  assert.equal(deriveCodexPhase(s).kind, "approval");
});

test("流式输出中 → outputting;只有 busy → thinking;都不占 → idle", () => {
  assert.equal(deriveCodexPhase({ ...emptyChatState, busy: true, streaming: "半句" }).kind, "outputting");
  assert.equal(deriveCodexPhase({ ...emptyChatState, busy: true }).kind, "thinking");
  assert.equal(deriveCodexPhase(emptyChatState).kind, "idle");
  assert.equal(deriveCodexPhase(emptyChatState).text, "", "空闲时那行不该有字");
});

test("产物没翻到头这类提示不该让 phase 变成 idle 以外的档", () => {
  // phase 只看"它在干什么",与"列表拉了多少"无关 —— 别顺手把别的状态并进去
  assert.equal(deriveCodexPhase({ ...emptyChatState, error: "连不上电脑" }).kind, "idle");
});

// ---------------------------------------------------------------- token

test("token 用量跟着 state 帧走;没这个字段时**保持原值**", () => {
  const s1 = applyChatFrame(emptyChatState, { t: "state", busy: true, tokens: 1234 });
  assert.equal(s1.tokens, 1234);
  // ⚠️ turn/started 那种不带 tokens 的 state 不能把它清掉 —— 清了头部那行会闪没
  const s2 = applyChatFrame(s1, { t: "state", busy: false });
  assert.equal(s2.tokens, 1234);
  // 带了就覆盖
  assert.equal(applyChatFrame(s2, { t: "state", busy: false, tokens: 9999 }).tokens, 9999);
});

test("token 文案:缺失时**什么都不显示**,不写一个 0", () => {
  assert.equal(tokensLabel(null), "");
  assert.equal(tokensLabel(0), "");
  assert.equal(tokensLabel(undefined), "");
  assert.ok(tokensLabel(1234).includes("1234"));
  assert.ok(tokensLabel(12345).includes("12.3k"), "上万折成 k");
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
