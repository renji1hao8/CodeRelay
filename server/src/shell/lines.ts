/**
 * 命令框的**字节 → 一块块输出**那一层。全是纯函数 / 纯状态机,不 spawn 任何东西 ——
 * 就为了能在一秒内跑完用例(`mobile/scripts/check-shell-lines.mjs`)。
 *
 * 这一层里有四件必须做对的事,每一件都有实测依据:
 *
 * 1. **pwsh 的 stderr 被重定向时是**一整份 CLIXML 文档**(`#< CLIXML … <S S="Error">…`)。
 *    而且 `Write-Error` / 语法错误 / **`Write-Host`** / `Write-Progress` 全都往那儿灌。
 *    原样转发就是"每条 Write-Host 后面跟一坨 XML"。
 * 2. **`\r` 必须处理**:`curl` / `npm` / `git clone` 的进度条靠它反复覆写同一行,不处理
 *    就是几千行垃圾 —— 而这正是使用者点名要跑的那类命令。
 * 3. **中文可能被切开**:一个 UTF-8 汉字跨两次 `data` 事件是常事,直接 `toString("utf8")`
 *    会在交界处变成替换字符。
 * 4. **ANSI 要剥**:App 不渲染转义序列,得在后端剥干净(两头各写一套必然漂移)。
 *
 * ⚠️ 关于 `\r` 有个反直觉的坑:**`\r\n` 是行尾,不是"回到行首重写"**。把 CRLF 当重写
 * 处理的话,每一行都会被清掉 —— 而 Windows 上 CRLF 遍地都是。所以扫描时要把
 * `\r\n` 当成一个 `\n`,并且**把落在块尾的那个 `\r` 留到下一块**再判(否则
 * 一次 data 事件正好切在 `\r` 和 `\n` 之间,就会误判)。
 */

import { TextDecoder } from "node:util";

/** 空的 Buffer,避免每次分配 */
const EMPTY = Buffer.alloc(0);

/**
 * 从尾部剥掉一个**被截断的** UTF-8 序列。
 *
 * 返回 `[能安全解码的部分, 留到下次的尾巴]`。最多往回看 3 个字节 —— 4 字节的序列
 * 也只需要最多 3 个续字节的余量。
 */
export function splitIncompleteUtf8(buf: Buffer): [Buffer, Buffer] {
  const n = buf.length;
  for (let back = 1; back <= 3 && back <= n; back++) {
    const b = buf[n - back]!;
    if ((b & 0x80) === 0) return [buf, EMPTY]; // ASCII 结尾 —— 一定是完整的
    if ((b & 0xc0) === 0x80) continue; // 续字节(10xxxxxx),接着往前找起始字节
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2; // 起始字节声明了总共几个字节
    return back < need ? [buf.subarray(0, n - back), buf.subarray(n - back)] : [buf, EMPTY];
  }
  return [buf, EMPTY];
}

/**
 * 把一个字节流的**多段 data** 解成文本。
 *
 * 两个职责:接住被切开的汉字;以及**在 UTF-8 解不出来时整段退回 gb18030**。
 *
 * ⚠️ 关于 gb18030 这条退路:这台机器系统代码页是 65001(UTF-8 全局),所以原生子进程
 * 默认就吐 UTF-8,GBK 今天**不会发生**。但那是系统级开关 —— 别人一改、或者这套东西
 * 搬到别的机器上,中文就全是乱码,而乱码很难被当成"编码问题"来排查。留这条退路的代价
 * 只有一次 `includes`。
 */
export class ByteDecoder {
  private carry: Buffer = EMPTY;
  /**
   * 一旦认了 gb18030 就一路用它。
   *
   * ⚠️ 认了之后**不能再走上面那套"扣下半截 UTF-8 序列"的逻辑** —— 那套判据是 UTF-8
   * 专用的:GBK 的"文"是 `CE C4`,而 `C4` 长得像一个 UTF-8 双字节序列的起始字节,
   * 于是会被扣下来,剩下的 `D6 D0 CE` 按 gb18030 解出来是"中"加一个残缺的替换字符。
   * 这一步是写用例时抓出来的(期望"中文"、实际"中�")。
   */
  private gbk: TextDecoder | null = null;

  push(buf: Buffer): string {
    if (this.gbk) return this.gbk.decode(buf, { stream: true });

    const all = this.carry.length > 0 ? Buffer.concat([this.carry, buf]) : buf;
    const [ok, rest] = splitIncompleteUtf8(all);
    const utf8 = ok.toString("utf8");
    if (!utf8.includes("�")) {
      this.carry = rest;
      return utf8;
    }

    // UTF-8 解不出来。**要把刚才扣下的那几个字节也算上再试 gb18030** —— 只解 `ok`
    // 那一段的话,一个汉字正好被切成两半,解出来还是替换字符。
    const tryGbk = new TextDecoder("gb18030");
    const gbkText = tryGbk.decode(all);
    if (!gbkText.includes("�")) {
      this.gbk = tryGbk;
      this.carry = EMPTY;
      return gbkText;
    }

    /**
     * 两条路都不行。最可能的情形是"GBK 的一个汉字被切开了"—— 下一块才能拼回来,
     * 所以先别急着吐乱码。但也不能无限攒(真遇到二进制流会把内存吃掉),
     * 超过 8 字节就当它确实是坏字节,照 UTF-8 的结果给出去(至少不吞东西)。
     */
    if (all.length <= 8) {
      this.carry = all;
      return "";
    }
    this.carry = rest;
    return utf8;
  }

  /** 流结束了 —— 尾巴上那几个字节不管完不完整都得解出来,不能悄悄吞掉 */
  flush(): string {
    if (this.gbk) return this.gbk.decode();
    const t = this.carry.toString("utf8");
    this.carry = EMPTY;
    return t;
  }
}

/**
 * ANSI 转义序列。
 *
 * 四种形态,`|` 的顺序是**长的在前**(短的先匹配就会把长序列切一半留下残渣):
 *   · CSI —— `\x1b[…` 到最后一个字节(`\x1b[0;32m` 这类)
 *   · OSC —— `\x1b]…` 到 BEL 或 ST(改窗口标题)
 *   · 字符集指定 —— `\x1b(B` 这种三字节的(实测 `git` 的输出里就有)
 *   · Fe 转义 —— `\x1b` + 一个 0x40~0x5F 的字符
 *
 * ⚠️ 包装器里已经设了 `$PSStyle.OutputRendering = 'PlainText'` + `NO_COLOR=1` +
 * `TERM=dumb`,**原生命令**通常也就不吐色了;这里剥的是漏网的那些 —— 两件都做,因为
 * 漏一个的后果是屏幕上出现 `[0;32m` 这种鬼东西。
 */
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[@-Z\\-_])/g;

export function stripAnsi(s: string): string {
  return ANSI.test(s) ? s.replace(ANSI, "") : s;
}

const CLIXML_HEAD = "#< CLIXML";

/**
 * pwsh 的 stderr 是不是 CLIXML 文档。
 *
 * 判据是**开头**那 10 个字符 —— 只有整份文档才有那个头,原生 stderr 是一段普通字节。
 */
export function looksLikeClixml(raw: string): boolean {
  return raw.startsWith(CLIXML_HEAD);
}

/**
 * pwsh 往 stderr 上写的东西有**两副面孔**,必须分开对待(实测,见 pwsh.ts 里那张表):
 *
 *   · **原生命令**的 stderr 是**原始字节** —— `node -e 'process.stderr.write("\r进度 1/5")'`
 *     经包装器之后 5 个 `\r` 一个不少地过来了。这一路**要立刻转发**,进度条才有意义。
 *   · **pwsh 自己**的报错 / `Write-Host` / 语法错误是**一整份 CLIXML 文档**
 *     (`#< CLIXML … <S S="Error">…`)。原样转发就是"每行后面跟一坨 XML"。这一路
 *     **整份攒到进程退出再解包**。
 *
 * 判据是开头那 10 个字符。一整条命令通常只有一种面孔,看一眼就能定下来;但
 * "**先出原生命令的进度、再出 pwsh 的报错**"是会发生的,所以"原始"那一档里还要继续
 * 盯着块首,见到 CLIXML 头就改成攒着。
 *
 * ⚠️ 已知边界:CLIXML 那一份是**攒到进程退出**才解包的,所以它的内容会排在原始输出
 * **之后**(顺序被打乱)。这是"不要一坨 XML"换来的代价,而实际的报错几乎总在最后,
 * 所以值得。
 */
export class StderrSplitter {
  private probe = "";
  private mode: "unknown" | "clixml" | "raw" = "unknown";
  private clixml = "";

  /** 返回**现在就该发出去的**文本(没有就是空串)。CLIXML 那份攒着,由 `finish` 交出来 */
  push(text: string): string {
    if (text.length === 0) return "";
    if (this.mode === "clixml") {
      this.clixml += text;
      return "";
    }
    if (this.mode === "unknown") {
      this.probe += text;
      if (this.probe.length < CLIXML_HEAD.length) return ""; // 还不够判
      if (looksLikeClixml(this.probe)) {
        this.mode = "clixml";
        this.clixml = this.probe;
        this.probe = "";
        return "";
      }
      this.mode = "raw";
      const out = this.probe;
      this.probe = "";
      return out;
    }
    // 已经是"原始"了 —— 但块首出现 CLIXML 头就说明 pwsh 开始报错了,改攒着
    if (text.startsWith(CLIXML_HEAD)) {
      this.mode = "clixml";
      this.clixml = text;
      return "";
    }
    return text;
  }

  /** 进程结束了。攒着的那份在这里解包交出来 */
  finish(): string {
    if (this.mode === "unknown") {
      // 输出太短,还没判出来 —— 当原始文本给出去,别吞
      const t = this.probe;
      this.probe = "";
      return t;
    }
    if (this.mode === "clixml") {
      const t = unwrapClixml(this.clixml);
      this.clixml = "";
      return t;
    }
    return "";
  }
}

/**
 * 把一份 CLIXML 文档解成纯文本。
 *
 * 只挑 `<S …>…</S>` 里包着的正文(它们是错误/警告/`Write-Host` 的实际内容),
 * 其余(XML 声明、命名空间、`<Obj>` 结构)全丢。
 *
 * ⚠️ 顺序不能反:先还原 `_xHHHH_`,再还 XML 实体。CLI 把控制字符(换行、制表)写成
 * `_x000A_` 这种形式**恰恰是为了让它们能活着穿过 XML** —— 先还 XML 的话,`_x0026_`
 * 会被当成普通的 `&` 参与实体解析,那就乱了。
 */
export function unwrapClixml(raw: string): string {
  if (!looksLikeClixml(raw)) return raw;
  const parts: string[] = [];
  const re = /<S(?:\s[^>]*)?>([\s\S]*?)<\/S>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) parts.push(decodeClixmlText(m[1] ?? ""));
  return parts.join("");
}

function decodeClixmlText(s: string): string {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** `LineAssembler` 吐出来的一块 */
export interface AssembledChunk {
  stream: "out" | "err";
  text: string;
  partial: boolean;
}

/**
 * 把**一个进程的输出流**切成一块块可以往手机上发的输出。
 *
 * ## 它保证的那条不变量(整个命令框都靠它)
 *
 * > **客户端连续应用这些块,得到的东西和真实终端上一模一样,而且一个字都不重复。**
 *
 * 做法是记住"当前这一行已经作为 partial 发出去多少字符了",于是:
 *
 *   · 一行**结束**(遇到 `\n`)时,只发"还没发出去的那一截 + `\n`",`partial: false`;
 *   · 一行**没结束**时,每 60ms 把**整行**作为 `partial: true` 发一次(客户端拿它替换
 *     当前行,所以重复发同一个内容是幂等的);
 *   · 遇到光杆 `\r`(不是 CRLF)时,发一块**空文本的 partial**把客户端那一行清掉。
 *
 * 第二种情形是"进度条"能看的关键:如果只在行结束时才发,一条 `curl` 会**整段时间
 * 什么都不显示**,跑完才哗地出来 —— 那就不是"边跑边看"了。
 *
 * ## 它不保证的
 *
 * stdout 和 stderr **共用一条当前行**(不是各记一条)。两路同时卡在半行上的情形
 * (`make -j` 那种交错)会把它们拼在一起,顺序略有出入。换取的是渲染规则简单到不可能
 * 出错 —— 而"输出重复/丢失"比"两路交错顺序略偏"难查得多。
 */
export class LineAssembler {
  /** 当前还没结束的那一行 */
  private pending = "";
  /** `pending` 里已经作为 partial 发出去的长度 */
  private emitted = 0;
  private pendingStream: "out" | "err" = "out";
  /** 落在块尾、还判不出是 CRLF 还是光杆 `\r` 的那个字节 */
  private carryCr = false;
  private queue: AssembledChunk[] = [];

  push(text: string, stream: "out" | "err"): void {
    if (text.length === 0) return;
    if (this.carryCr) {
      text = "\r" + text;
      this.carryCr = false;
    }
    // 末尾那个 \r 留到下一块再判 —— 它后面跟的可能就是 \n(CRLF),而那意味着"行尾"
    if (text.endsWith("\r")) {
      this.carryCr = true;
      text = text.slice(0, -1);
    }

    let i = 0;
    while (i < text.length) {
      const nl = text.indexOf("\n", i);
      const cr = text.indexOf("\r", i);
      const useNl = nl !== -1 && (cr === -1 || nl < cr);
      const at = useNl ? nl : cr;

      if (at === -1) {
        this.pending += text.slice(i);
        this.pendingStream = stream;
        return;
      }

      this.pending += text.slice(i, at);
      this.pendingStream = stream;

      if (useNl) {
        this.endLine(stream);
        i = at + 1;
      } else if (text[at + 1] === "\n") {
        // `\r\n` = Windows 行尾,**不是**重写。按重写处理会把每一行都清掉
        this.endLine(stream);
        i = at + 2;
      } else {
        // 光杆 \r:光标回到行首,这一行要被覆写 → 先把客户端那一行清掉
        if (this.emitted > 0) this.queue.push({ stream, text: "", partial: true });
        this.pending = "";
        this.emitted = 0;
        i = at + 1;
      }
    }
  }

  /**
   * 这一行结束了。
   *
   * ⚠️ 发的是 `pending.slice(emitted)` + `\n` —— **不是**整个 `pending`。
   *
   * 因为这一行很可能已经作为 `partial` 发出去过了(冲刷过),客户端手上正显示着它。
   * 再发一遍完整的一行,客户端那边就是"这一行出现两遍"(追加语义)。只补"还没发出去的
   * 那一截",追加之后得到的正好是完整的这一行,一个字不重不漏。
   */
  private endLine(stream: "out" | "err"): void {
    this.queue.push({ stream, text: this.pending.slice(this.emitted) + "\n", partial: false });
    this.pending = "";
    this.emitted = 0;
  }

  /**
   * 把攒下的块取走(每 60ms 调一次)。
   *
   * 顺序是"先已完成的那些行,再当前这一行" —— 后者带 `partial`,渲染时替换最后一行,
   * 所以它必须排在最后。
   */
  flush(): AssembledChunk[] {
    if (this.pending.length > this.emitted) {
      this.queue.push({ stream: this.pendingStream, text: this.pending, partial: true });
      this.emitted = this.pending.length;
    }
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /**
   * 进程结束了。
   *
   * 最后那一行**没有 `\n` 也要留下来** —— `Write-Output "done"` 不一定带换行,吞掉它
   * 就是"命令的输出少了一行"。这里用 `partial: false` 而不是 `partial: true`:进程都没了,
   * 那一行不会再被覆写,不该继续以"当前行"的身份存在。
   */
  finish(stream: "out" | "err"): AssembledChunk[] {
    // 尾随的光杆 \r 在进程退出时没有意义(它后面再也不会有内容来覆写),丢掉
    this.carryCr = false;
    if (this.pending.length > this.emitted) {
      this.queue.push({ stream: this.pendingStream, text: this.pending.slice(this.emitted), partial: false });
    }
    this.pending = "";
    this.emitted = 0;
    void stream;
    const out = this.queue;
    this.queue = [];
    return out;
  }
}
