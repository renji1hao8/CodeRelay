import net from "node:net";

/**
 * 探一个本地端口有没有人在听。
 *
 * 给"这台机器上那几个组件活着没有"用:`index.ts` 的 `/api/health` 用它探 cc-switch
 * 与 mihomo,`diagnostics.ts` 用它探同样这几个再加后端自己。
 *
 * ⚠️ 八百毫秒就放弃。调用方都是**给人看状态**的,不是连通性验收 —— 没在跑的端口
 * 正常会立刻 `ECONNREFUSED`,只有"连上了但没人应"那种才会耗到超时,而那种情况下
 * 多等几秒也还是同一个答案。
 *
 * ⚠️ 探的是**端口**,不是进程。一个端口通只说明"有人在那儿听",不说明那个程序是好的
 * (cc-switch 监听正常但上游凭据失效,这里照样是 true)。所以它只能当线索用。
 */
export function probePort(port: number, host = "127.0.0.1", timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}
