import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * 命令框要跑的那个 pwsh(7)在哪儿。
 *
 * ⚠️ **判据只能是"真起一次",不能是 `fs.existsSync`。**(2026-10-13 改的)
 *
 * 这台机器上 pwsh 是 **Microsoft Store 版**,于是有两条路,而**两条都会被
 * `existsSync` 判成"不在"**:
 *
 * | 路径 | `fs.existsSync` | `stat` | 真起 |
 * |---|---|---|---|
 * | `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe` | true | OK | ✓ |
 * | `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` | **false** | **抛 EACCES** | **✓** |
 * | `pwsh`(裸名字) | false | 抛 ENOENT | ✓ |
 *
 * 第二行是坑:`%LOCALAPPDATA%\Microsoft\WindowsApps\` 里那些不是普通文件,而是
 * **应用执行别名**(IO_REPARSE_TAG_APPEXECLINK 的 reparse point),`stat` 直接 EACCES。
 * 于是"探一个绝对路径备用"那段**在这台机器上永远命中不了** —— 而第一条路只在
 * PATH 里恰好带着那个版本号目录时才成立(版本号一变就断)。
 * 结果就是后端一直报"找不到 pwsh、这个 tab 用不了",而它在任何终端里都好用。
 *
 * 所以:候选**逐条真起一次**(`-Command "exit 0"`),谁能跑就用谁;最后再试裸名字
 * (CreateProcess 会解析别名)。探一次就记住,不进每条命令的热路径。
 */
let cached: string | null | undefined;

/** 上一次探过哪些、各自什么结果 —— 失败时打进日志,省得靠猜 */
let lastTried: string[] = [];

export function resolvePwsh(): string | null {
  if (cached !== undefined) return cached;
  cached = findPwsh();
  return cached;
}

/** 探一次,并把结论打到日志里(参数是后端那个 logger) */
export function reportPwsh(log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }): void {
  const exe = resolvePwsh();
  if (exe) log.info({ pwsh: exe }, "命令框:已找到 pwsh");
  else
    log.warn(
      { hint: "装一个 PowerShell 7,或用 REMOTE_CC_PWSH 指定绝对路径", tried: lastTried },
      "命令框:找不到 pwsh,这个 tab 用不了",
    );
}

/**
 * 能不能**真的跑起来** —— 这才是判据(理由见文件头那张表)。
 *
 * `-Command "exit 0"` 只要求它启动、解析参数、退 0;不加载 profile(`-NoProfile`)，
 * 所以不会被谁的历史遗留拖慢。超时是防"起得来但卡住"那种 —— 那种当它不可用更安全。
 */
function canRun(exe: string): boolean {
  if (!exe) return false;
  try {
    execFileSync(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
      timeout: 8000,
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function findPwsh(): string | null {
  const tried: string[] = [];
  lastTried = tried;

  const attempt = (exe: string): string | null => {
    if (!exe) return null;
    tried.push(exe);
    return canRun(exe) ? exe : null;
  };

  // 1. 显式指定优先 —— 换机器 / Store 版抽风时的逃生口
  const fromEnv = process.env.REMOTE_CC_PWSH;
  if (fromEnv) {
    const hit = attempt(fromEnv);
    if (hit) return hit;
  }

  // 2. `where.exe` 报的**每一条都试** —— 不能只试第一条。它列出的第一条往往是
  //    `C:\Program Files\WindowsApps\Microsoft.PowerShell_<版本>\pwsh.exe`,
  //    而那个"版本号目录在不在 PATH 上"是环境说了算的,不归我们管。
  try {
    const out = execFileSync("where.exe", ["pwsh.exe"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      const hit = attempt(line);
      if (hit) return hit;
    }
  } catch {
    // where 在找不到时退出码非 0 —— 这是正常分支,不是错误
  }

  // 3. 常见落点(装到默认位置的那种)
  for (const p of [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7-preview", "pwsh.exe"),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe")
      : "",
  ]) {
    const hit = attempt(p);
    if (hit) return hit;
  }

  // 4. 最后试裸名字:CreateProcess 自己会去解析 PATH 与应用执行别名。
  //    ⚠️ 不能因为"它不是个文件"就跳过 —— 它恰恰是**这台机器上最靠得住的一条**。
  return attempt(process.platform === "win32" ? "pwsh" : "pwsh");
}

/**
 * 包装脚本。
 *
 * 它做四件事,每一件都是实测出来的:
 *
 * 1. **`$ProgressPreference = 'SilentlyContinue'`** —— 进度记录只会以 CLIXML 灌进 stderr,
 *    对手机没有任何价值。
 * 2. **`$PSStyle.OutputRendering = 'PlainText'`** —— 连 pwsh 自己给原生命令加的色一起剥。
 *    ⚠️ 加 `if ($PSStyle)` 的守卫:`$PSStyle` 是 PS7 才有的,万一 `REMOTE_CC_PWSH`
 *    指向 5.1,不加守卫这一句就会抛("不能对 Null 值表达式调用方法"),而那会变成
 *    "每条命令都报一句莫名其妙的错"。
 * 3. **`[Console]::OutputEncoding` 钉成无 BOM 的 UTF-8** —— 否则中文按控制台代码页出去。
 * 4. **`6>&1 3>&1 2>&1`** —— 把 pwsh 自己那几个额外的流(3=warning,6=information)
 *    并进 stdout。见下面那张表,这是个有取舍的选择。
 *
 * ## 实测出来的那张表(2026-09-21,`scripts/.cache/exp-clixml.mjs` 与 `exp-native-cr.mjs`)
 *
 * | 谁写的 | 落在哪 | 什么形状 |
 * |---|---|---|
 * | 原生命令 → stdout | stdout | **原始字节**,`\r` 一个不少 |
 * | 原生命令 → stderr | stderr | **原始字节**,`\r` 一个不少 |
 * | `Write-Error` / 语法错误 | stderr | **CLIXML 文档** |
 * | `Write-Host`(带 `6>&1`) | stdout | 按顺序流式,但每条被补上 `\r\n` |
 * | `Write-Host`(不带 `6>&1`) | stderr | CLIXML 文档(攒到退出才解包) |
 *
 * ⚠️ **CLIXML 的触发条件是 `-EncodedCommand`,不是"stderr 被重定向"。** 这是我原先记错
 * 的一条:`-Command "Write-Error 'boom'"` 的 stderr 是普通文本 `Write-Error: boom\r\n`,
 * 只有 `-EncodedCommand` 那份才带 `#< CLIXML` 头。错记成"被重定向"会让人以为换个起法
 * 就能绕开它,白试一轮。
 *
 * ⚠️ 而且 `Write-Error` 那份 CLIXML **不受**这三个重定向影响 —— 三种写法下 stdout 都是
 * 空的、stderr 都是 CLIXML。所以"靠重定向消掉 CLIXML"这条路是走不通的,只能**解包**
 * (见 `lines.ts::StderrSplitter`)。
 *
 * 于是 `6>&1` 的取舍是:留着 → `Write-Host` 按顺序实时出来(好),代价是它写的进度条
 * `-NoNewline` 失效、变成很多行;去掉 → 进度条能靠 CLIXML 里的 `_x000D_` 还原,但要等
 * 进程退出才看得到(对进度条来说等于没用)。**留着**,因为**原生命令**的进度条
 * (`curl` / `npm` / `git clone`,那才是真正要跑的东西)走的是原始字节那条路,
 * **两种写法下都完好无损**。
 *
 * ⚠️ 命令本体走**环境变量 `RC_CMD`**,不走命令行 —— `-EncodedCommand` 传的是这段包装,
 * 命令原文一个字节都不经过命令行解析,引号/`$`/反引号全都不用转义。
 *
 * ⚠️ **故意不传 `-ExecutionPolicy`**:让他自己的策略(RemoteSigned)生效。加了 Bypass
 * 就等于"从手机上下载的脚本也直接跑",这条通道不该悄悄放宽执行策略。
 */
const WRAPPER = [
  "$ErrorActionPreference = 'Continue'",
  "$ProgressPreference = 'SilentlyContinue'",
  "if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }",
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  "$LASTEXITCODE = 0",
  "try { & ([scriptblock]::Create($env:RC_CMD)) 6>&1 3>&1 2>&1 }",
  "catch { Write-Output ('[CodeRelay] 命令没能开始:' + $_.Exception.Message) }",
  "exit $LASTEXITCODE",
].join("\n");

/** `-EncodedCommand` 要的是 UTF-16LE 的 base64 */
export function encodedWrapper(): string {
  return Buffer.from(WRAPPER, "utf16le").toString("base64");
}

/** 给 pwsh 的参数。`-NonInteractive` 让 `Read-Host` 明确报错,而不是"看不见地挂住" */
export function pwshArgs(): string[] {
  const args = ["-NoLogo", "-NonInteractive", "-EncodedCommand", encodedWrapper()];
  // `-NoProfile` 是默认;他的 PROFILE 里可能有 PATH / venv 的设置,需要时打开
  if (process.env.REMOTE_CC_SHELL_PROFILE !== "1") args.splice(1, 0, "-NoProfile");
  return args;
}

/**
 * 给子进程的环境:剥掉会捣乱的那些,补上让输出"干净"的那些。
 *
 * ⚠️ **`PSExecutionPolicyPreference` 一定要删。** agent 那侧的工具环境里带着一个继承来的
 * `Bypass`(见根 CLAUDE.md 里那段"agent 在自己这边试是试不出来的"),它会**盖掉**
 * 上面"故意不传 -ExecutionPolicy"那个设计 —— 留着就等于偷偷放宽了策略。
 */
export function pwshEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PSExecutionPolicyPreference;
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  return env;
}
