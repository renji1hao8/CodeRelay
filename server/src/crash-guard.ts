/**
 * 最后一道兜底:**进程不该因为一个没人管的 socket 事件就整个退出。**
 *
 * ## 为什么需要它
 *
 * 2026-10-11 与 2026-10-13,后端两次死在同一条路上:一个 `net.Socket`(子进程的
 * stdin 管道)**没有挂 `error` 监听**,对端没了之后那笔写报 `EPIPE`,而
 * `node:events` 对"没人接的 error 事件"的处理是**直接抛出** —— 不是日志、不是 503,
 * 是进程当场退出。手机那一端看到的只是"连不上"。
 *
 * 根因已经按 socket 逐个修掉了(`codex/client.ts` 的 stdin 监听器就是其中一处),
 * 但这类错误的性质是:**任何一个新写的 `spawn` / `net.connect` 只要漏挂一个监听器,
 * 就又是一条同样的路**。而这个项目的兜底只有 `watchdog.ps1`,它 **5 分钟才探一次**
 * —— 也就是说漏一处,人就在外面失去连接好几分钟。
 *
 * 所以这里补一张网。它**不是**给已知问题用的(已知问题要按 socket 修),而是给
 * "我没想到的那一处"用的。
 *
 * ## 代价,以及为什么仍然值得
 *
 * Node 的文档说:发生未捕获异常之后进程处于"未定义状态",官方建议退出。这条对
 * **无状态**的服务成立,而这个后端正是:状态全在 SQLite(事务)与 jsonl(append)里,
 * 一次野事件几乎不可能让它们不一致;而"退出"的代价是确定的 —— **手机黑屏 5 到 10 分钟**
 * (要等 watchdog),以及"后端到底为什么挂的"这个额外谜题。
 *
 * 两害相权,选活着。计数器留在日志里:真出现"每几秒一次"的循环时,那行 `第 N 次`
 * 会自己暴露出来,而不是让人对着一份安静的日志猜。
 */

/** 最近这条是从哪儿冒出来的 —— 日志里要能分清是后端还是救援进程 */
export function installCrashGuard(label: string): void {
  let uncaught = 0;

  const note = (text: string) => {
    // ⚠️ 包一层:stderr 自己也可能坏掉(它被重定向到文件),那时**不能再抛一次**
    try {
      process.stderr.write(text.endsWith("\n") ? text : text + "\n");
    } catch {
      /* 连报错都写不出去,那也没有别的办法了 */
    }
  };

  process.on("uncaughtException", (err) => {
    uncaught++;
    note(
      `[crash-guard] ${label}:第 ${uncaught} 次未捕获异常,进程继续跑 ——\n` +
        `${err?.stack ?? String(err)}`,
    );
  });

  process.on("unhandledRejection", (reason) => {
    note(
      `[crash-guard] ${label}:未处理的 Promise 拒绝 ——\n` +
        `${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
  });
}
