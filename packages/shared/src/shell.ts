/**
 * 命令框(在手机上跑电脑的 pwsh)里**唯一那份纯逻辑**。
 *
 * 放 shared 是因为两端都要用它:后端按这套语义**产出**输出块,App 按同一套语义
 * **渲染**出来。两边各写一份必然漂移,而漂移的表现是"手机上看到的和实际跑出来的不一样"
 * —— 这种错没人会发现。
 *
 * ## 核心约定:`partial` 是**替换当前那一行**
 *
 * 终端输出里有两种东西混在一起:
 *   · 正常的一行一行(`\n` 结尾)—— **追加**
 *   · 进度条(`curl` / `npm` / `git clone` 那种,靠 `\r` 反复覆写同一行)—— **替换**
 *
 * 不区分的话,一条 `curl` 的进度条会变成几千行垃圾 —— 而这恰恰是使用者点名要在手机上
 * 跑的那类命令。所以:
 *
 *   `partial === false` → 这段文本**追加**到已有内容后面(它自带结尾的 `\n`)
 *   `partial === true`  → 这段文本是**当前那一行**,把已有内容最后一行整个换掉
 *
 * ⚠️ **不重复的保证在后端那边**(它记着"这一行已经发出去多少字符了",非 partial 的块
 * 只带剩下的部分)。所以这里的渲染规则可以简单到不可能出错 —— 这也是故意的:重复
 * 渲染出来的表现是"输出里每行都出现两遍",而那个症状在这个项目里已经出现过一次
 * (见根 CLAUDE.md 坑 40,聊天气泡那次),没人想再查一遍。
 */

/** 一块输出 */
export interface ShellChunk {
  /** 单调递增。重连时靠它算"我手上这份还差哪几块" */
  seq: number;
  stream: "out" | "err";
  text: string;
  /**
   * `true` = 这是**当前那一行**,替换掉已有内容的最后一行(进度条的 `\r` 语义);
   * `false` = 追加。
   */
  partial: boolean;
}

/** 一次命令执行 */
export interface ShellJob {
  jobId: string;
  command: string;
  cwd: string;
  startedAt: string;
  running: boolean;
  /**
   * 退出码。**被"打断"结束的一律是 `null`** —— 硬终止没有退出码,显示一个 0 或 -1
   * 都是在编("命令成功了吗?"这个问题在打断这条路上没有答案)。
   */
  exitCode: number | null;
  /** 是被"打断"结束的(硬终止,命令来不及做任何清理) */
  stopped: boolean;
  /** 输出超了环形缓冲的上限,更早的那部分没留 */
  truncated: boolean;
  /** 手上这块输出从哪个 seq 开始、到哪个 seq 结束(重连时对齐用) */
  seqFrom: number;
  seqTo: number;
}

/** 历史命令里的一条(存在后端,随快照下发) */
export interface ShellHistoryEntry {
  command: string;
  cwd: string;
  at: string;
  /** `null` = 被打断,没有退出码 */
  exitCode: number | null;
}

/** 同时能跑几条。3 条是"一个长构建 + 临时查一下"的余量,不是性能上限 */
export const SHELL_MAX_JOBS = 3;
/** 每分钟最多发起几次(按设备)—— 它不是安全边界(token 才是),只是别让死循环把后端打爆 */
export const SHELL_MAX_PER_MINUTE = 60;
/** 一条命令最多跑多久。到点**只提示、不杀** —— 长构建真的会跑很久 */
export const SHELL_TIMEOUT_MS = 2 * 60 * 60_000;
/** 命令文本上限。超了就是粘贴事故 */
export const SHELL_COMMAND_MAX = 8 * 1024;
/** 单帧上限 */
export const SHELL_FRAME_MAX = 32 * 1024;
/** 环形缓冲:块数与字符数两个上限,谁先到算谁 */
export const SHELL_RING_CHUNKS = 4000;
export const SHELL_RING_CHARS = 1_000_000;
/** 重连时快照最多给多长的尾巴 */
export const SHELL_TAIL_CHARS = 128 * 1024;
/** 出帧节奏:每 60ms 最多一帧,否则一个大输出会生成几千个定时器 */
export const SHELL_FLUSH_MS = 60;
/** 命令历史留多少条(存在后端 kv,不下发全量) */
export const SHELL_HISTORY_MAX = 200;
/** App 侧一次最多渲染多少字符,超了只渲染尾部并明说 */
export const SHELL_RENDER_CHARS = 60_000;

/**
 * 把一串输出块渲染成人看的一行行文本。
 *
 * 规则就只有两条(`partial` 替换当前行 / 否则追加),见文件头那段说明。
 */
export function renderShellChunks(chunks: ShellChunk[]): string {
  let out = "";
  for (const c of chunks) {
    if (c.partial) {
      const cut = out.lastIndexOf("\n");
      out = out.slice(0, cut + 1) + c.text;
    } else {
      out += c.text;
    }
  }
  return out;
}

/**
 * 重连时把"手上这份"和"服务端快照那份"对齐。
 *
 * 服务端只有一个环形缓冲(命令这边**没有第二份来源**,不像聊天那样还有历史 jsonl),
 * 所以快照就是回放。对齐规则:
 *
 *   · 快照接得上(`snap[0].seq === 手上最后一块 + 1`)→ 只补差值
 *   · 接不上(中间断了 / 服务端把缓冲裁过 / 手上是空的)→ **整段换成服务端那份**
 *
 * ⚠️ 接不上时整段换是**会丢前面那截的**,这是有意的:宁可少一段老的,也不要两段
 * 拼在一起 —— 拼出来的东西每一行都可能出现两遍,那比缺一段难查得多。
 */
export function mergeShellChunks(prev: ShellChunk[], snap: ShellChunk[]): ShellChunk[] {
  if (snap.length === 0) return prev;
  const first = snap[0];
  const last = prev[prev.length - 1];
  if (!first) return prev;
  if (!last || first.seq > last.seq + 1) return snap;
  const add = snap.filter((c) => c.seq > last.seq);
  return add.length === 0 ? prev : [...prev, ...add];
}
/** Persistent interactive terminal, separate from legacy one-command jobs. */
export type TerminalClientFrame =
  | { t: "terminal_open"; cols: number; rows: number; fresh?: boolean }
  | { t: "terminal_input"; id: string; data: string }
  | { t: "terminal_resize"; id: string; cols: number; rows: number };
export type TerminalServerFrame =
  | { t: "terminal_state"; id: string; seq: number; cols: number; rows: number; screen: string; running: boolean; exitCode: number | null }
  | { t: "terminal_data"; id: string; seq: number; data: string }
  | { t: "terminal_exit"; id: string; exitCode: number }
  | { t: "terminal_error"; message: string };
