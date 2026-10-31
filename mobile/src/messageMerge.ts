/**
 * 消息列表的合并与身份判定。
 *
 * 单独一个模块、且**不 import 任何 React / expo 的东西**,是为了让这段逻辑
 * 能在裸 Node 里跑真值用例(`scripts/.cache/probe-merge-history.mjs`)——
 * 它错了的表现是"同一条消息弹出两个气泡",而那要重装 APK 上真机才看得见。
 *
 * 为什么需要"身份"这件事:App 的消息有两个来源 —— 实时流(**本地回显**,
 * uuid 是本地造的 `local-N`)与历史回放(jsonl 里的真 uuid)。同一个气泡在两边的
 * 身份不同,合并时只比 uuid 会让它出现两次。
 */
import type { ChatBlock, ChatMessage } from "./shared";

let localId = 0;

/**
 * 造一条**本地回显**消息(uuid 形如 `local-N`)。
 *
 * 两种场合:自己发的消息先画出来(不等服务端索引),以及**首条根本不是从聊天页
 * 发出去**的那种 —— 新建会话时 prompt 是随创建请求一起送出的,聊天页里不补一条
 * 回显,那条消息就永远没有气泡(见 SessionsScreen.startNew)。
 */
export function makeLocalMessage(role: "user" | "assistant", blocks: ChatBlock[]): ChatMessage {
  localId += 1;
  return { uuid: `local-${localId}`, role, ts: new Date().toISOString(), blocks };
}

/** 一条消息的纯文本 —— 只用来做去重比较 */
export function plainTextOf(m: ChatMessage): string {
  return m.blocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
}

/**
 * 列表里是不是**已经有**等同于这条的消息(按指纹比)。
 *
 * 给**回放**用。回放补的是"你不在的那一小段",而那段内容 CLI 早就写进 jsonl、
 * 也早被索引进 App 手里那份历史了 —— 也就是说它**多半已经在列表里**。原样追加就会
 * 让同一段话出现两遍(使用者报的「agent 的话重复两遍甚至多遍」)。
 *
 * ⚠️ 只回答"有没有",不负责合并:认上之后**什么都不做**(保留原来那条)是对的 ——
 * 历史那条带着真 uuid,而且可能还多带 thinking 块,比回放这条更全。
 * 万一把"模型真把同一段话说两遍"认成了一条,损失也有限:回放里那条同时在 jsonl 里,
 * 补历史那一趟会按它自己的 uuid 把它补回来(那次是陌生 uuid,走的是正常追加)。
 */
export function alreadyHave(
  messages: ChatMessage[],
  role: "user" | "assistant",
  blocks: ChatBlock[],
): boolean {
  const sig = identityOf({ uuid: null, role, ts: null, blocks });
  if (!sig) return false;
  return messages.some((m) => m.role === role && identityOf(m) === sig);
}

/**
 * 这段**累积增量**是不是在复述列表里已经有的内容。
 *
 * 给回放的增量用的。回放会把"你不在时那段输出"再流一遍 —— 逐字的增量,而那些字
 * 与历史里那条消息的**开头完全相同**。认出它就别画:画了就是"同一段话在屏幕上
 * 又打了一遍",然后等那条 assistant_message 回来才被认亲抹掉 —— 一闪一灭,比不看
 * 还糟。
 *
 * ⚠️ **只看最后几条**(`ECHO_LOOKBACK`)。回放覆盖的是"你不在的那一小段",对应的
 * 一定是历史最新那几条;而全表扫的代价是:长回答几千个增量帧 × 几百条消息 ×
 * 每次几 KB 的字符比较 = 手机上几百毫秒的卡顿,只为了省一次误判。
 */
const ECHO_LOOKBACK = 20;
export function echoesExisting(
  messages: ChatMessage[],
  role: "user" | "assistant",
  prefix: string,
): boolean {
  if (!prefix) return true;
  for (let i = messages.length - 1, seen = 0; i >= 0 && seen < ECHO_LOOKBACK; i -= 1, seen += 1) {
    const m = messages[i]!;
    if (m.role !== role) continue;
    if (plainTextOf(m).startsWith(prefix)) return true;
  }
  return false;
}

/**
 * 一条消息的**身份指纹**,用来把本地回显和它后来的历史真身对上。
 *
 * ⚠️ 为什么不能只比 uuid:回显的 uuid 是本地造的 `local-N`,而历史回来的那条带的是
 * jsonl 里的真 uuid —— 同一个气泡,两个身份。补历史时如果只认 uuid,回显一个都挡不住,
 * 服务端那条真身会原样再插一遍(实测表现:一次输入弹出两个一样的气泡)。
 *
 * 分三档取指纹,越靠前越精确:
 *   1. 正文 —— 最常用,也是最可靠的(同一句话在两边逐字节相同)
 *   2. 工具 id —— 没有正文的消息(纯工具调用 / 纯工具结果)靠它,全局唯一
 *   3. 块类型形状 —— 只发图不配字的消息:两边路径不同(本地是设备 URI、历史是
 *      电脑路径),内容比不了,只能比形状。配合下面**先进先出**的认领顺序够用
 */
export function identityOf(m: ChatMessage): string | null {
  const text = plainTextOf(m);
  if (text) return `${m.role}:text:${text}`;

  const ids = m.blocks
    .map((b) => (b.type === "tool_use" ? b.id : b.type === "tool_result" ? b.toolUseId : ""))
    .filter((s): s is string => !!s);
  if (ids.length > 0) return `${m.role}:tool:${ids.join(",")}`;

  const shape = m.blocks.map((b) => b.type).join("+");
  return shape ? `${m.role}:shape:${shape}` : null;
}

/**
 * 把重连后补拉到的历史并进现有列表。
 *
 * ⚠️ **不能整份替换**。列表里混着"本地回显"的消息(uuid 形如 `local-N`)——
 * 那是刚发出去、服务端还没索引进去的,整份替换会把它抹掉,用户会以为自己刚打的字没了。
 *
 * 去重的正解是**让历史真身认领回显**:同一个气泡在两边各有一个身份(见 identityOf),
 * 认上了就**就地替换** —— 位置不变(那正是它当时出现的位置),而且换完之后它带上了
 * 真 uuid,再补一次历史也不会重复。
 *
 * ⚠️ 这里以前只对"入参是 `local-*` 的消息"才按正文比对,而**历史回来的每条都带真
 * uuid**,那个分支永远不命中 —— 于是重连一次,实时流建的消息就全被重复插一遍。
 */
export function mergeHistory(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current;

  const known = new Set(current.map((m) => m.uuid).filter((u): u is string => !!u));
  const out = current.slice();

  /** 还没被认领的本地回显:指纹 → 下标队列(先进先出,同一个指纹出现多次也能一一对上) */
  const echoes = new Map<string, number[]>();
  out.forEach((m, i) => {
    if (!m.uuid?.startsWith("local-")) return;
    const sig = identityOf(m);
    if (!sig) return;
    const queue = echoes.get(sig) ?? [];
    queue.push(i);
    echoes.set(sig, queue);
  });

  const fresh: ChatMessage[] = [];
  for (const m of incoming) {
    if (m.uuid && known.has(m.uuid)) continue; // 已经在列表里了
    const sig = identityOf(m);
    const queue = sig ? echoes.get(sig) : undefined;
    const at = queue?.shift();
    if (at !== undefined) {
      out[at] = m;
    } else {
      fresh.push(m);
    }
    if (m.uuid) known.add(m.uuid);
  }
  if (fresh.length === 0) return out;

  // 没被认领的历史条目插在末尾那串**仍是回显**的消息之前 —— 那些是最新的,
  // 服务端还没来得及索引
  let at = out.length;
  while (at > 0 && out[at - 1]?.uuid?.startsWith("local-")) at -= 1;

  out.splice(at, 0, ...fresh);
  return out;
}
