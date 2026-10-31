/**
 * 给一条 WebSocket 挂**探活**:连着两个周期没等到 pong 就当它死了,关掉。
 *
 * ## 为什么需要它
 *
 * 手机切后台时 socket 是**悄悄烂掉**的 —— 服务端既收不到 FIN、也没人往里写,
 * `close` 可以几十分钟都不触发。那条连接于是**一直"看起来还在"**,而依赖它的三件事都会错:
 *
 *   1. **通知该不该发**(没人看着才发)—— 烂掉的订阅者会让它判成"有人在看",
 *      于是**该通知的时候反而不通知**。那比"人正看着也多弹一条"糟得多:
 *      后者只是烦,**前者是这件事整个失效**。
 *   2. **reaper 该不该回收会话** —— 它按 `subscriberCount > 0` 跳过,
 *      于是一个烂连接能让一条早已没人的会话**永远不被回收**。
 *   3. **帧日志的水位与回放** —— 也按"有没有订阅者"走,同样被它带偏。
 *
 * 主动 ping 是**唯一**能分辨"真的没人了"和"TCP 还凑合着"的办法:
 * 单看 `readyState` 分不出来 —— 烂掉的连接上它可能还是 OPEN。
 *
 * ⚠️ 用 `terminate()` 而不是 `close()`:后者是"体面地告别",而对一条已经没人管的
 * 连接它会一直等回应,等于没做。
 *
 * ⚠️ `ws` 是 `@fastify/websocket` 的**传递依赖**,不是我们的直接依赖 ——
 * 所以这里按**结构**声明用到的那几个方法,不去引它的类型。
 */
interface LiveSocket {
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): unknown;
  off(event: "pong", listener: () => void): unknown;
}

/** 探活周期。15 秒与心跳同频 —— "真的死了"最多 30 秒被发现 */
export const LIVENESS_INTERVAL_MS = 15_000;

/**
 * 挂上探活。
 *
 * @returns 停掉它的函数 —— 调用方**必须**在 close / error 里调,否则定时器会一直跑
 */
export function armLiveness(socket: LiveSocket, intervalMs = LIVENESS_INTERVAL_MS): () => void {
  let alive = true;
  const onPong = () => {
    alive = true;
  };
  socket.on("pong", onPong);

  const timer = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    try {
      socket.ping();
    } catch {
      // 已经死了 —— 下一次 tick 会把它收拾掉
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
    socket.off("pong", onPong);
  };
}
