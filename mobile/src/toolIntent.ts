/**
 * 从工具调用的 input 里抠出"这次到底在动什么"。
 *
 * ToolCards 的一行摘要与 ApprovalCard 的审批标题原先各写了一遍同样的判断链
 * (Bash 取 command、有 file_path 就取路径、有 url 就取网址)。加一类新工具就得
 * 改两处,漏掉一处那一边就退化成直接把原始 JSON 摊给用户看。
 *
 * 这里把判断链收成一份,两边只是取用的字段不同:摘要只要 detail,
 * 审批卡还要 headline。
 */

export interface ToolIntent {
  /** Human-readable purpose; keep separate from the actual command/path. */
  description: string;
  /** 这次在做什么,一句话(给审批卡用) */
  headline: string;
  /**
   * 具体对象:命令全文 / 文件路径 / 搜索词 / 网址。没有就是空串,
   * 此时调用方应退回到展示原始参数。
   */
  detail: string;
}

interface Field {
  key: string;
  headline: string;
  /**
   * 是否要在标题里带上工具名。
   *
   * 命令和网址本身已经说明了一切;而"要操作文件"必须带上是 Read 还是 Write ——
   * 同样是碰文件,读和写的风险完全不是一回事。
   */
  withTool: boolean;
}

/** 顺序即优先级,越靠前越具体 */
const FIELDS: Field[] = [
  { key: "command", headline: "要执行命令", withTool: false },
  { key: "file_path", headline: "要操作文件", withTool: true },
  { key: "pattern", headline: "要搜索内容", withTool: false },
  { key: "prompt", headline: "要发起任务", withTool: false },
  { key: "url", headline: "要访问网址", withTool: false },
];

export function toolIntent(tool: string, input: unknown): ToolIntent {
  if (!input || typeof input !== "object") return { headline: tool, detail: "", description: "" };
  const obj = input as Record<string, unknown>;
  const purpose = [obj.description, obj.justification, obj.summary, obj.title].find(v => typeof v === "string" && v.trim());
  const description = typeof purpose === "string" ? purpose.trim() : "";

  for (const f of FIELDS) {
    const value = obj[f.key];
    if (typeof value !== "string" || !value) continue;
    return {
      headline: f.withTool ? `${f.headline} · ${tool}` : f.headline,
      detail: value,
      description,
    };
  }

  // 认不出来(mcp__xxx 之类的新工具)就报工具名,让调用方去摊原始参数 ——
  // 瞎猜一个标题比不猜更误导
  return { headline: tool, detail: "", description };
}

/**
 * 能"被调"的 shell → 卡片上显示的名字。
 *
 * ⚠️ 为什么需要它:Bash 工具**永远只走一个 shell**(Windows 上是 Git for Windows 的
 * bash),Claude Code 没有"用 PowerShell 跑"这种工具 —— 想到 pwsh / cmd / WSL,唯一
 * 的途径是**在命令里显式调**。所以"这次到底在哪儿跑的"只能从命令的第一个词看出来。
 * 使用者的原话:「执行命令框只能知道在执行工具,不知道用的是 cmd/git bash/pwsh7/pwsh5/wsl」。
 *
 * ⚠️ **`bash` / `sh` 不在这张表里,是有意的。** 本机 2026-09-20 实测报过一次误判:
 * `bash scripts/build-android-apk.sh` 被标成「嵌套 bash」—— 而那走的就是外层那个
 * Git Bash 本身。这个角标要回答的是"**换了个不一样的 shell 没有**",同族的不算,
 * 标了只有噪音。
 *
 * ⚠️ 两个 PowerShell 分开报,而且**按可执行文件区分**,不按版本号猜:
 * 这台机器上 `powershell` 是系统自带的 5.1(`C:\Windows\System32\WindowsPowerShell\v1.0\`)、
 * `pwsh` 是单独装的 7.6.6,两个都在 Git Bash 的 PATH 上,所以模型直接写哪个就是哪个。
 */
const NESTED_SHELLS: Record<string, string> = {
  cmd: "cmd",
  // ⚠️ 别写成 "PowerShell 5" —— 用户机器上**两个都有**,只差一个数字看不出来
  powershell: "PowerShell 5.1",
  pwsh: "PowerShell 7",
  wsl: "WSL",
};

/**
 * 一个片段里"被执行的那个程序"是什么。
 *
 * 只认**第一个命令词**,但要多吃两种写法 —— 都是实测会出现的:
 *   - `& "C:\Program Files\...\pwsh.exe" -Command ...`(调用操作符 + 带空格的路径)
 *   - `"C:\...\pwsh.exe" -Command ...`(引号包着,因为路径里有空格)
 * 原来直接 `split(/\s+/)[0]`,这两种的首词分别是 `&` 和 `"C:\Program` —— 一个都认不出,
 * 而 7 常常就是这么被调的(它的安装路径在 WindowsApps 下面,带空格)。
 *
 * ⚠️ **不要**改成"扫前几个词找匹配":`git commit -m "fix pwsh"` 里的 `pwsh` 会被误判,
 * 而那种误报比漏报更烦人。只看第一个命令词,认不出就认不出。
 */
function commandWordOf(segment: string): string | null {
  const m = /^\s*(?:[&!]\s*)?("[^"]+"|'[^']+'|[^\s]+)/.exec(segment);
  if (!m || !m[1]) return null;
  return m[1].replace(/^["']|["']$/g, "");
}

/**
 * 命令有没有显式调另一个 shell;有就返回它的名字。
 *
 * 段的边界是换行 / `&&` / `;`。
 * ⚠️ 有意**不**把 `|` 当边界:管道右边几乎总是别的工具而不是 shell,而且引号里的内容
 * 会被切碎,切成碎片后第一个词撞上 `sh` 这种短名字的概率不低。
 *
 * 这只是个显示用的启发式,判错了顶多多一个角标,不影响任何执行路径。
 */
export function nestedShellOf(command: string): string | null {
  for (const seg of command.split(/\r?\n|&&|;/)) {
    const first = commandWordOf(seg);
    if (!first) continue;
    // 去掉路径前缀和 .exe 后缀:C:\Windows\System32\cmd.exe → cmd
    const name = first.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
    const hit = NESTED_SHELLS[name];
    if (hit) return hit;
  }
  return null;
}
