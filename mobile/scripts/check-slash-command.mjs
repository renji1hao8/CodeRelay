/**
 * `slashCommand.ts::slashCommandOf` 的真值用例。
 *
 * 为什么值得单独一个脚本:这个判据**管两件事** —— 命令气泡要不要上色、这条消息要不要
 * 在本地被当命令路由。判错的后果一个要在真机上翻到那条气泡才看得见,另一个是"看起来
 * 是命令、实际被当成普通消息发给了模型"。这里把真实出现过的写法摆出来跑,几毫秒判定。
 *
 * ⚠️ 用例里**必须同时有该认的和不该认的**。只测"该认的"那种用例,把判据改成 `return true`
 * 都能全过 —— 那是假绿灯。见下方「不该认的」那一组。
 *
 * 用法:`node mobile/scripts/check-slash-command.mjs`(退出码即结论)
 */
import assert from "node:assert/strict";
import { slashCommandOf } from "../src/slashCommand.ts";

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/**
 * 该认的。除了三个字段,还统一验一条**显示保真**的不变式:
 * 按 `nameEnd` 切两段再拼回去必须一字不差 —— 渲染就是靠这个切片复用原文的。
 */
const cmd = (text, want) =>
  test(`「${text.replace(/\n/g, "\\n")}」 → ${want.name}${want.args ? ` + 「${want.args}」` : ""}`, () => {
    const got = slashCommandOf(text);
    assert.ok(got, "没认出来");
    assert.equal(got.nameEnd, want.nameEnd, "nameEnd 不对");
    assert.equal(got.name, want.name, "name 不对");
    assert.equal(got.args, want.args, "args 不对");
    assert.equal(text.slice(0, got.nameEnd) + text.slice(got.nameEnd), text, "切片拼不回原文");
    assert.ok(
      text.slice(0, got.nameEnd).toLowerCase().endsWith(got.name),
      "nameEnd 没落在命令名末尾",
    );
  });

const no = (text) =>
  test(`「${text.replace(/\n/g, "\\n")}」 → 不是命令`, () => {
    assert.equal(slashCommandOf(text), null);
  });

// ---------------------------------------------------------------- 该认的
cmd("/compact", { nameEnd: 8, name: "compact", args: "" });
cmd("/push 结果.md", { nameEnd: 5, name: "push", args: "结果.md" });
cmd("/push a.md\n第二行", { nameEnd: 5, name: "push", args: "a.md\n第二行" });
cmd("/code-review HEAD~1", { nameEnd: 12, name: "code-review", args: "HEAD~1" });
// 大小写:显示要保留原文(nameEnd 落在原文坐标里),路由只认小写
cmd("/Push Foo", { nameEnd: 5, name: "push", args: "Foo" });
// 名字里的冒号(上游带前缀的写法)
cmd("/a:b c", { nameEnd: 4, name: "a:b", args: "c" });
// 前后有空白:nameEnd 要算回**原文**坐标,不能按 trim 过的算
cmd("  /compact  ", { nameEnd: 10, name: "compact", args: "" });
cmd("\n/elevate ping\n", { nameEnd: 9, name: "elevate", args: "ping" });
// 参数中间的空格原样留着(args 只 trim 两头)
cmd("/push  a  b ", { nameEnd: 5, name: "push", args: "a  b" });

// ---------------------------------------------------------------- 不该认的
// 句中出现斜杠 —— 路径、除号、URL 都有斜杠,认了只会让正常句子花掉
no("说 /push 一下");
no("/usr/bin/x 不存在");
no("1 / 2 = 0.5");
no("见 https://example.com");
// 开头是斜杠但不是命令
no("//compact");
no("/");
no("/1abc");
no("/ 前面有空格的空命令");
// 命令名后面直接跟别的字符(没空白分隔)
no("/exit。");
no("/compact;ls");
// 普通正文
no("abcd");
no("");
no("   ");

// ---------------------------------------------------------------- 已知的误报
// ⚠️ 这一条**故意**钉住当前行为:以斜杠开头、后面接一句中文,仍会被认成"命令 + 参数"。
// 收拢判据之前就是这样,不是新引入的。要消掉它得让后端存权威字段(升 PARSER_VERSION),
// 代价不成比例 —— 所以先用用例把它记在这里,别让以后的人以为它是对的。
cmd("/home 是我要的目录", { nameEnd: 5, name: "home", args: "是我要的目录" });

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
