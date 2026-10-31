/**
 * 极简内存缓存。
 *
 * 为什么需要它:四个 tab 是条件渲染(`{tab === "x" ? <XScreen/> : null}`),
 * 切走就卸载、切回就重新挂载,于是每次回来都要重新发一轮请求 ——
 * 经组网隧道走一圈,眼睛能明显看出在等。
 *
 * 用法是 stale-while-revalidate:挂载时先用缓存里的旧数据把界面铺上(瞬间可见),
 * 同时照常发请求,回来了再覆盖。用户看到的是"立刻有内容",而不是转圈。
 *
 * 只活在进程内存里,杀进程就没了 —— 这是有意的:它解决的是"切 tab"这种秒级问题,
 * 不适合当持久缓存用。
 */

const store = new Map<string, unknown>();

/** 取缓存。没有就返回 null(调用方据此决定是否显示加载态) */
export function peek<T>(key: string): T | null {
  const v = store.get(key);
  return v === undefined ? null : (v as T);
}

export function put<T>(key: string, value: T): void {
  store.set(key, value);
}

/**
 * 全清。链路恢复、重新配对、token 失效这类"上下文整个变了"的时候调 ——
 * 否则会把上一个后端的数据当作当前后端的显示出来。
 */
export function clearAll(): void {
  store.clear();
}
