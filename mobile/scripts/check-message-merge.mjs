/**
 * `messageMerge.ts` 的真值用例。
 *
 * 为什么值得单独一个脚本:这段逻辑错了的表现是**同一个气泡出现两次** ——
 * 而那要重装 APK、上真机、切一次屏才看得见。这里把当时真实发生过的形状
 * (实时流的 `local-*` 回显 + 历史里的真 uuid)摆出来跑,几毫秒就能判定。
 *
 * ⚠️ 后半段(`alreadyHave` / `echoesExisting`)是"重连回放"那套判据 ——
 * 使用者报的「agent 的话重复两遍甚至多遍,退出重进解决不了」的直接病根。
 *
 * 用法:`node mobile/scripts/check-message-merge.mjs`(退出码即结论)
 */
import assert from "node:assert/strict";
import { alreadyHave, echoesExisting, makeLocalMessage, mergeHistory } from "../src/messageMerge.ts";

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const text = (s) => [{ type: "text", text: s }];
const uuidOf = (m) => m.uuid;

/** 造一条"看起来来自历史"的消息(带真 uuid) */
const fromHistory = (uuid, role, blocks) => ({ uuid, role, ts: null, blocks });

// ---------------------------------------------------------------- 用例

test("重连补历史:实时流建的消息不该被再插一遍", () => {
  // 列表里是实时流画出来的:一条用户消息 + 一条助手回复,都是本地回显
  const echoUser = makeLocalMessage("user", text("你好"));
  const echoAsst = makeLocalMessage("assistant", text("在,什么事"));
  const current = [echoUser, echoAsst];

  // 历史里是同一个气泡,只是 uuid 是真的(实测:库里 41916 条全是真 uuid)
  const incoming = [
    fromHistory("U1", "user", text("你好")),
    fromHistory("A1", "assistant", text("在,什么事")),
  ];

  const out = mergeHistory(current, incoming);
  assert.equal(out.length, 2, "条数必须还是 2 —— 多了就是「一次输入两个气泡」");
  assert.deepEqual(out.map(uuidOf), ["U1", "A1"], "而且回显要**就地**被真身顶掉,位置不变");
});

test("就地替换之后,再补一次同样的历史也不重复", () => {
  const echo = makeLocalMessage("user", text("你好"));
  const once = mergeHistory([echo], [fromHistory("U1", "user", text("你好"))]);
  const twice = mergeHistory(once, [fromHistory("U1", "user", text("你好"))]);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].uuid, "U1");
});

test("没有正文的消息靠工具 id 认身份", () => {
  const echoUse = makeLocalMessage("assistant", [{ type: "tool_use", id: "tool_1", name: "Bash", input: {} }]);
  const echoRes = makeLocalMessage("user", [
    { type: "tool_result", toolUseId: "tool_1", text: "ok", isError: false },
  ]);
  const incoming = [
    fromHistory("A2", "assistant", [{ type: "tool_use", id: "tool_1", name: "Bash", input: {} }]),
    fromHistory("U2", "user", [{ type: "tool_result", toolUseId: "tool_1", text: "ok", isError: false }]),
  ];
  const out = mergeHistory([echoUse, echoRes], incoming);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(uuidOf), ["A2", "U2"]);
});

test("只发图不配字:两边路径不同,靠形状认(先进先出)", () => {
  const echo = makeLocalMessage("user", [
    { type: "image", path: "file:///data/user/0/dev.remotecc.mobile/cache/a.jpg", mediaType: "image/jpeg", size: 10 },
  ]);
  const incoming = [
    fromHistory("U3", "user", [
      { type: "image", path: "E:\\cc_pocket_list\\uploads\\ab12.jpg", mediaType: "image/jpeg", size: 10 },
    ]),
  ];
  const out = mergeHistory([echo], incoming);
  assert.equal(out.length, 1, "同一个气泡在两边各有一个身份,不认形状就会变成两个");
});

test("正文相同的两条消息:一一对上,不多不少", () => {
  const e1 = makeLocalMessage("user", text("继续"));
  const e2 = makeLocalMessage("user", text("继续"));
  const out = mergeHistory([e1, e2], [
    fromHistory("U4", "user", text("继续")),
    fromHistory("U5", "user", text("继续")),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(uuidOf), ["U4", "U5"], "先进先出,顺序不能反过来");
});

test("断线期间漏掉的消息要补进来,并插在还没索引的回显之前", () => {
  // 列表:历史里已有的一条 + 断线前最后那条回显
  const seeded = fromHistory("S1", "user", text("开头这句"));
  const echo = makeLocalMessage("user", text("刚发出去还没进库"));
  const out = mergeHistory([seeded, echo], [
    fromHistory("S1", "user", text("开头这句")), // 已在列表里,跳过
    fromHistory("H1", "assistant", text("断线期间它回的那段")),
  ]);
  assert.deepEqual(out.map(uuidOf), ["S1", "H1", echo.uuid], "补进来的历史必须排在**仍未认领**的回显前面");
});

test("问一答一并发、历史只到了一半时,不会串位", () => {
  const e1 = makeLocalMessage("user", text("问题"));
  const e2 = makeLocalMessage("assistant", text("回答"));
  // 历史只索引到用户那条(助手那条还没落进索引)
  const out = mergeHistory([e1, e2], [fromHistory("U6", "user", text("问题"))]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(uuidOf), ["U6", e2.uuid], "助手那条得留着,不能被顶掉");
});

// ------------------------------------------------- 回放:认亲(「重复两遍」的病根)

test("回放送来一条历史里已经有的回答 → 认出来,不许再追加", () => {
  // 打开会话时拉的历史里已经有这段回答(CLI 早就写进 jsonl 了)
  const seeded = [fromHistory("A9", "assistant", text("这段回答你已经在看了"))];
  // 重连时后端又把"你不在那段"回放一遍 —— 同一个气泡
  assert.equal(alreadyHave(seeded, "assistant", text("这段回答你已经在看了")), true);
});

test("回放送来的是新内容(断线期间它刚说的) → 认不出,该追加", () => {
  const seeded = [fromHistory("A9", "assistant", text("上一句"))];
  assert.equal(alreadyHave(seeded, "assistant", text("断线期间新说的这句")), false);
});

test("认亲要认角色:用户打的字不能顶掉助手的话", () => {
  const seeded = [fromHistory("U9", "user", text("同一段字"))];
  assert.equal(alreadyHave(seeded, "user", text("同一段字")), true);
  assert.equal(alreadyHave(seeded, "assistant", text("同一段字")), false, "角色不同 = 不是同一条");
});

test("没有正文的消息(纯工具调用)也认得出,靠工具 id", () => {
  const blocks = [{ type: "tool_use", id: "tool_7", name: "Bash", input: { command: "ls" } }];
  const seeded = [fromHistory("A10", "assistant", blocks)];
  assert.equal(alreadyHave(seeded, "assistant", blocks), true);
  assert.equal(
    alreadyHave(seeded, "assistant", [{ type: "tool_use", id: "tool_8", name: "Bash", input: {} }]),
    false,
    "工具 id 不同就是另一次调用",
  );
});

test("工具结果按 toolUseId 认 —— 那一趟调用只有一次结果", () => {
  const seeded = [fromHistory("U10", "user", [{ type: "tool_result", toolUseId: "t1", text: "ok", isError: false }])];
  assert.equal(alreadyHave(seeded, "user", [{ type: "tool_result", toolUseId: "t1", text: "ok", isError: false }]), true);
  assert.equal(alreadyHave(seeded, "user", [{ type: "tool_result", toolUseId: "t2", text: "ok", isError: false }]), false);
});

test("回放的增量如果是在复述已有的内容 → 咽掉,别在屏幕上再打一遍", () => {
  const seeded = [fromHistory("A11", "assistant", text("这段话你已经在看了"))];
  // 逐字流出来的前缀,一路都该认出来
  assert.equal(echoesExisting(seeded, "assistant", "这段"), true);
  assert.equal(echoesExisting(seeded, "assistant", "这段话你已经在"), true);
  assert.equal(echoesExisting(seeded, "assistant", ""), true, "空串不算新内容");
});

test("增量一旦岔开(新内容)就不再是复述", () => {
  const seeded = [fromHistory("A11", "assistant", text("这段话你已经在看了"))];
  assert.equal(echoesExisting(seeded, "assistant", "这段话你已经在看了接下来是新的"), false);
  assert.equal(echoesExisting(seeded, "assistant", "另起一句"), false);
});

test("复述判据只看最近几条 —— 老消息不该把新回答误判成复述", () => {
  const old = fromHistory("A0", "assistant", text("很久以前说过一模一样的话"));
  const filler = Array.from({ length: 25 }, (_, i) => fromHistory(`F${i}`, "assistant", text(`第 ${i} 句`)));
  assert.equal(
    echoesExisting([old, ...filler], "assistant", "很久以前说过一模一样的话"),
    false,
    "隔着 25 条:回放覆盖的是「你不在的那一小段」,对不上就是新内容",
  );
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
