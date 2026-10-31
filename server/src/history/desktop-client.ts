import { Worker } from "node:worker_threads";
let worker: Worker | null = null, nextId = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
function getWorker() {
  if (worker) return worker;
  const current = new Worker(new URL("./desktop-worker.ts", import.meta.url));
  worker = current; current.unref();
  current.on("message", message => {
    const waiter = pending.get(message.requestId);
    if (!waiter) return;
    pending.delete(message.requestId); clearTimeout(waiter.timer);
    message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.value);
    if (!pending.size) current.unref();
  });
  const died = () => {
    if (worker !== current) return;
    worker = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("历史索引进程已结束，下次读取会重新连接")); }
    pending.clear();
  };
  current.on("error", died); current.on("exit", died);
  return current;
}
export function historyRequest(method: "sessions" | "detail" | "codexDetail" | "claudeIdentity", id?: string, cursor?: string): Promise<any> {
  const current = getWorker(), requestId = ++nextId;
  current.ref();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("历史索引仍在准备，请稍后刷新")); if (!pending.size) current.unref(); }, 30000);
    pending.set(requestId, { resolve, reject, timer }); current.postMessage({ requestId, method, id, cursor });
  });
}
export async function stopHistoryWorker() {
  if (worker) await worker.terminate();
}
