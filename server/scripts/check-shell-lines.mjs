/**
 * 命令框**纯逻辑**的用例:字节解码 / 剥色 / CLIXML 解包 / `\r` 组装 / 快照对齐。
 *
 * 不 spawn 任何东西、不碰后端,一秒内跑完。退出码即结论。
 *
 * ## 为什么这些必须有用例
 *
 * `\r` 那套组装的正确性**在真机上几乎看不出来**:错了的表现是"进度条变成几千行"
 * 或者"某一行出现了两遍",而那两个症状都能被解释成"命令本来就这么输出的"。加上
 * App 那边按同一套规则渲染,一处错就是两端一起错。所以把它钉在这儿。
 *
 * ## 判据是手算的,不是照着实现抄的
 *
 * 每一条的期望值都是**照真实终端上应该显示成什么样**写下来的。想证伪就改实现:
 *   · 把 `LineAssembler` 里"只在行结束时才发"那套改回"每块原样转发" → D/E 两组立刻红;
 *   · 把 `\r\n` 当成光杆 `\r`(CRLF 当重写)→ C/F 两组立刻红(每一行都被清掉);
 *   · 把 `unwrapClixml` 改成永远返回固定串 → I 组的**反例**(原生 `oops` 必须原样回来)红。
 *
 * 用法:`node server/scripts/check-shell-lines.mjs`
 */
import {
  ByteDecoder,
  LineAssembler,
  looksLikeClixml,
  splitIncompleteUtf8,
  stripAnsi,
  unwrapClixml,
} from "../src/shell/lines.ts";
import { mergeShellChunks, renderShellChunks } from "../../packages/shared/src/shell.ts";

let passed = 0;
let failed = 0;
function check(ok, what, extra = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${what}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${what}${extra ? ` —— ${extra}` : ""}`);
  }
}
function eq(actual, expected, what) {
  check(actual === expected, what, `期望 ${JSON.stringify(expected)},实际 ${JSON.stringify(actual)}`);
}

/** 走一遍完整的"推 → 每 60ms 冲刷 → 结束",返回渲染出来的文本 */
function run(pushes, { flushEvery = 1, stream = "out" } = {}) {
  const a = new LineAssembler();
  const chunks = [];
  let n = 0;
  for (const p of pushes) {
    a.push(p, typeof p === "object" && p.err ? "err" : stream);
    n += 1;
    if (flushEvery > 0 && n % flushEvery === 0) chunks.push(...a.flush());
  }
  const rest = a.flush();
  chunks.push(...rest);
  chunks.push(...a.finish("out"));
  return { text: renderShellChunks(chunks), chunks };
}

/* --------------------------------------------------------- 汉字被切开 -- */

console.log("\n[1] 一个汉字跨两次 data 事件");
{
  const bytes = Buffer.from("中文测试\n", "utf8");
  const cut = 5; // "中" 是 3 字节 + "文" 是 3 字节 → 第 5 字节落在"文"的中间
  const d = new ByteDecoder();
  const a = d.push(bytes.subarray(0, cut));
  const b = d.push(bytes.subarray(cut));
  eq(a + b + d.flush(), "中文测试\n", "被切开的汉字拼得回来");
  check(!(a + b).includes("�"), "中途不出现替换字符");
}
{
  const [ok, rest] = splitIncompleteUtf8(Buffer.from("好", "utf8").subarray(0, 2));
  eq(ok.length, 0, "splitIncompleteUtf8:半截序列整个留到下次");
  eq(rest.length, 2, "留下来的正是那 2 个字节");
}
{
  // 负例:一个完整的 ASCII 结尾不许被当成半截
  const [ok, rest] = splitIncompleteUtf8(Buffer.from("ok", "utf8"));
  eq(rest.length, 0, "ASCII 结尾不扣留任何字节");
  eq(ok.toString("utf8"), "ok", "ASCII 原样解码");
}
{
  // gb18030 退路:GBK 的"中文"是 D6 D0 CE C4,按 UTF-8 解一定出替换字符
  const d = new ByteDecoder();
  eq(d.push(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), "中文", "UTF-8 解不出来时退回 gb18030");
}

/* --------------------------------------------------------------- 剥色 -- */

console.log("\n[2] ANSI 剥色");
eq(stripAnsi("\x1b[0;32mOK\x1b[0m"), "OK", "CSI 颜色码剥掉");
eq(stripAnsi("\x1b]0;标题\x07正文"), "正文", "OSC(改窗口标题)整段剥掉");
eq(stripAnsi("plain text"), "plain text", "没有转义序列时一个字不动");
eq(stripAnsi("a\x1b(Bb"), "ab", "两字符的转义也剥掉");

/* ------------------------------------------------------------- CLIXML -- */

console.log("\n[3] CLIXML 解包");
{
  const raw =
    '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
    '<S S="Error">boom_x000D__x000A_</S><S S="Error">第二行</S></Objs>';
  const text = unwrapClixml(raw);
  check(text.includes("boom"), "解出来含正文 boom");
  check(!text.includes("CLIXML"), "不含 CLIXML 那个头");
  check(!text.includes("<S"), "不含 XML 标签");
  eq(text, "boom\r\n第二行", "正文与换行都还原对了(_x000D__x000A_ → CRLF)");
}
{
  // ⚠️ 负例,不能省:少了它,一个"永远返回固定串"的实现也能通过上面那组
  eq(unwrapClixml("oops"), "oops", "原生 stderr(不带 CLIXML 头)原样返回");
  check(!looksLikeClixml("oops"), "原生 stderr 不被认成 CLIXML");
  check(looksLikeClixml("#< CLIXML\n<Objs/>"), "带头的认成 CLIXML");
}

/* ---------------------------------------------------- \r 组装与渲染 -- */

console.log("\n[4] \\r 组装(进度条)");
eq(run(["hello\n", "world\n"]).text, "hello\nworld\n", "普通两行原样留下");
eq(run(["hello\nworld\n"]).text, "hello\nworld\n", "一次推两行也一样");
eq(run(["a\r\nb\r\n"]).text, "a\nb\n", "CRLF 是行尾,不是重写(把每行清掉就是这里错的)");
{
  // ⚠️ 落在块尾的 \r 得留到下一块再判 —— 否则一次 data 正好切在 \r 和 \n 之间就误判
  eq(run(["abc\r", "\n"]).text, "abc\n", "\\r 与 \\n 被切成两块时仍按 CRLF 算");
}
{
  const { text } = run(["10%\r20%\r30%\n"]);
  eq(text, "30%\n", "进度条只剩最后那一段(前两段被覆写掉了)");
}
{
  /**
   * ⚠️ **本文件最关键的一条**:中间冲刷过、然后那一行才结束。
   *
   * 冲刷时已经把 "10%" 作为当前行发给了客户端;随后 `\r` 把它清掉、换成 "20%",
   * 最后 `\n` 收尾。要是"行结束时"发的是完整的一行而不是**剩下的那一截**,
   * 渲染出来就是 "10%20%\n" —— 而真机上那就是"这一行出现了两遍"。
   */
  const { text, chunks } = run(["10%", "\r", "20%\n"], { flushEvery: 1 });
  eq(text, "20%\n", "冲刷过之后那一行结束,不许重复");
  check(
    chunks.some((c) => c.partial) && chunks.some((c) => !c.partial),
    "这一串里两种块都出现过(否则这条用例什么都没验到)",
  );
}
{
  const { text } = run(["10%", "\r", "20%", "\r", "30%", "\n"], { flushEvery: 1 });
  eq(text, "30%\n", "三段进度条、每段都冲刷过,仍然只有最后一段");
}
eq(run(["no-newline"]).text, "no-newline", "最后一行没有换行也要留下");
eq(run(["a\n", "b"]).text, "a\nb", "有换行的照常,末尾没换行的也留下");
{
  const a = new LineAssembler();
  a.push("bare", "out");
  const t = renderShellChunks([...a.flush(), ...a.finish("out")]);
  eq(t, "bare", "只冲刷不结束:当前行是 partial,渲染出来还是它");
}
{
  const { text } = run(["开始\n", "编译中 50%\r", "编译中 90%\r", "编译中 100%\n", "完成\n"], {
    flushEvery: 2,
  });
  eq(text, "开始\n编译中 100%\n完成\n", "混合场景:普通行 + 进度条 + 收尾");
}

console.log("\n[5] 两路输出");
{
  const a = new LineAssembler();
  a.push("stdout 一行\n", "out");
  a.push("stderr 一行\n", "err");
  const chunks = [...a.flush(), ...a.finish("out")];
  eq(renderShellChunks(chunks), "stdout 一行\nstderr 一行\n", "out/err 交错也按顺序拼起来");
  eq(chunks[1].stream, "err", "第二块的 stream 标成 err");
  check(chunks.every((c) => c.text.includes("\n") || c.partial), "非 partial 的块都以换行收尾");
}

/* ------------------------------------------------------- 快照对齐 -- */

console.log("\n[6] 重连时的快照对齐");
{
  const mk = (seq, text, partial = false) => ({ seq, stream: "out", text, partial });
  const prev = [mk(1, "a\n"), mk(2, "b\n")];
  eq(mergeShellChunks(prev, [mk(3, "c\n")]).length, 3, "接得上就只补差值");
  eq(mergeShellChunks(prev, [mk(2, "b\n"), mk(3, "c\n")]).length, 3, "快照带重叠也不产生重复");
  eq(mergeShellChunks(prev, [mk(1, "a\n"), mk(2, "b\n")]).length, 2, "快照全是已有的就什么都不加");
  eq(mergeShellChunks(prev, [mk(5, "x\n")]).length, 1, "中间断了就整段换成服务端那份");
  eq(mergeShellChunks(prev, []).length, 2, "空快照不动手上的");
  eq(mergeShellChunks([], [mk(9, "y\n")]).length, 1, "手上是空的就直接用快照");
  // 重叠 + 新增的那份,文本上也不许出现两遍
  const merged = mergeShellChunks(prev, [mk(2, "b\n"), mk(3, "c\n")]);
  eq(renderShellChunks(merged), "a\nb\nc\n", "对齐之后渲染出来不重不漏");
}
{
  /**
   * 端到端的样子:冲刷过一半 → 断线 → 服务端快照接上。
   *
   * ⚠️ `seq` 是**作业层**(`jobs.ts`)发的号,组装器本身不管 —— 环形缓冲和编号都在那边。
   * 所以这里得自己编,否则 `mergeShellChunks` 拿 `undefined` 比大小全是 NaN、
   * 一块都补不进来(这条用例第一版就是这么写的,红了一次)。
   */
  let seq = 1;
  const number = (cs) => cs.map((c) => ({ ...c, seq: seq++ }));
  const a = new LineAssembler();
  a.push("下载中 40%", "out");
  const before = number(a.flush());
  a.push("\r下载中 80%", "out");
  const after = number(a.flush());
  // 服务端缓冲里是同一串块(它就是唯一那份来源)
  const merged = mergeShellChunks(before, [...before, ...after]);
  eq(renderShellChunks(merged), "下载中 80%", "重连补上之后渲染出的仍是当前那一行");
  eq(merged.length, 3, "补进来的正好是缺的那两块,已有的不重复");
}

/* ------------------------------------------------------------------ */

console.log(`\n=== ${passed}/${passed + failed} 通过${failed ? `,${failed} 个失败` : ""} ===`);
process.exitCode = failed ? 1 : 0;
