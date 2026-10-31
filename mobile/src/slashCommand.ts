/**
 * 「整条消息就是一条斜杠命令」的判据 —— **一处定义,两处共用**。
 *
 * 原来有两份实现:`MessageBubble` 里一份管上色(前缀匹配),`ChatScreen` 里一份管路由
 * (整条锚定)。两者对同一个输入**会给出不同答案** —— 例如 `/exit。`(命令名后面紧跟一个
 * 中文句号):管画的那份认为它是命令、染成橙色,管路由的那份不认、于是当成普通消息发给
 * 模型。于是"看起来是命令、实际没被当命令处理",谁也说不清哪个才算数。
 *
 * 现在统一成**管路由那份更严的判据**:上色的就是会被当命令处理的,反之亦然。
 *
 * ⚠️ 已知的误报(不是这次能修的):`/home 是我要的目录` 这种"以斜杠开头、后面接着一句
 * 中文"的正文仍会被认成命令 + 参数。要彻底消掉它得让后端在解析时存一个权威字段
 * (那要把 `PARSER_VERSION` 升一级、让全部会话的消息重索引一遍),代价与收益不成比例,
 * 所以先留着。这个误报在收拢之前**就存在**,不是新引入的。
 */

export interface SlashCommand {
  /**
   * 命令名结束的位置 —— 在**原文**的坐标里。
   *
   * 取位置而不是取"名字字符串 + 参数字符串",是为了让显示能**一字不改地**复用原文:
   * `text.slice(0, nameEnd)` 是命令名(含开头的斜杠),`text.slice(nameEnd)` 是参数
   * (含中间那段空白)。拼字符串会把连续空格/换行归一化,显示的正文就和原来不一样了。
   */
  nameEnd: number;
  /** 小写、去掉斜杠的名字 —— 路由用(显示要保留使用者打的大小写,所以和上面分开) */
  name: string;
  /** 参数(已 trim)。没有参数时是空串 */
  args: string;
}

/**
 * 整条锚定:开头是斜杠 + 字母,后面只能跟命令名字符,然后是空白 + 参数或结束。
 *
 * 名字允许 `[\w:-]`:斜杠命令里真的出现过 `code-review` 这种带连字符的;
 * 冒号是历史上见过上游带前缀的写法。
 */
const WHOLE_COMMAND = /^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/;

export function slashCommandOf(text: string): SlashCommand | null {
  const raw = text.trim();
  const m = WHOLE_COMMAND.exec(raw);
  const name = m?.[1];
  if (!m || !name) return null;

  // ⚠️ `nameEnd` 必须换回**原文**坐标:上面 trim 过,而调用方是拿原文去 slice 的。
  //    前面有多少空白被 trim 掉,就得补回去多少。
  const lead = text.length - text.trimStart().length;
  return {
    nameEnd: lead + 1 + name.length, // +1 是开头那个斜杠
    name: name.toLowerCase(),
    args: (m[2] ?? "").trim(),
  };
}

/** 只要"是不是"时用这个,免得调用方去写 `!== null` */
export function isSlashCommand(text: string): boolean {
  return slashCommandOf(text) !== null;
}
