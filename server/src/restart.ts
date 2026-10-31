import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.ts";

/**
 * 排一次后端重启 —— 主后端(`routes/recovery.ts`)与救援进程(`rescue.ts`)共用这一份。
 *
 * 两处各写一遍的话,最危险的偏差是**延迟或脚本路径改了一处** —— 那时候一条路会
 * 立刻把后端收掉(包括发起它的那条会话流),而另一条正常。症状是"有时候点了会断线"。
 */

/**
 * 重启前留出的秒数。
 *
 * 10 秒,而不是 `restart-backend-later.ps1` 默认的 120 秒:那个默认值的用途是
 * "让 agent 把这句话说完,再留出使用者读完并回一句的时间"。而这条路的发起方
 * **就是使用者本人**(他在手机上按的),他已经在等着了 —— 再让他等两分钟没道理。
 * 10 秒足够把那个 202 走过隧道送到手机上。
 */
export const RESTART_DELAY_SEC = 10;

/**
 * 重启脚本的位置。
 *
 * 从 `config.dataDir` 反推仓根(`<仓根>/server/data`),而不是写死 `E:\RemoteCC` ——
 * 项目路径含中文,写死的字面量散得到处都是的话,哪天挪个目录就有一堆地方要跟着改。
 *
 * ⚠️ 用的是 **`-later`** 那个,不是同步版:它先脱身(`Start-Process` 起一个独立进程)
 * 再动手,所以发起它的进程可以立刻返回。用同步版会先杀掉调用链、再收到自己身上,
 * 后端反而停在旧代码上(坑 42,静默失败过七次)。
 */
export function restartScriptPath(): string {
  return path.resolve(import.meta.dirname, "../../deploy/restart-backend-later.ps1");
}

/** 脚本在不在。不在的话调用方要说清楚**是哪条路径**找不到,而不是干等 */
export function restartScriptExists(): boolean {
  return fs.existsSync(restartScriptPath());
}

/**
 * 把重启安排上,**立刻返回**。
 *
 * ⚠️ 调用方必须**先把响应发出去**再调它:这个动作会把后端连同发起它的进程一起收掉
 * (手机那条会话流正是后端的 claude 子进程)。顺序反了的话,那个回应永远到不了手机上,
 * 表现是"点了没反应",而其实重启已经发生了。
 *
 * `setTimeout(…, 0)` 只是把"动手"挪到当前事件循环之后,让 send 先落地;真正给隧道
 * 留的时间是脚本自己那 10 秒。`detached` + `unref` 是让它**立刻脱离本进程树** ——
 * 脚本内部还会再起一个真正独立的进程,这里只是别让这个短暂的 pwsh 成为
 * `Stop-Descendants` 的靶子。
 */
export function launchRestart(onError: (err: unknown) => void): void {
  const script = restartScriptPath();
  setTimeout(() => {
    try {
      spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-DelaySeconds",
          String(RESTART_DELAY_SEC),
        ],
        { detached: true, stdio: "ignore", windowsHide: true },
      ).unref();
    } catch (err) {
      onError(err);
    }
  }, 0);
}
