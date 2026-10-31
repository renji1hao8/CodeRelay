/**
 * 把 markdown 里的图片来源解析成 App 能直接加载的 URL。
 *
 * 用模块级 setter 而不是 React context:Markdown 嵌在
 * ChatScreen → Turn → MessageBubble 下面好几层,要把 api 一路透传下去,
 * 得给四五个中间组件凭空加一个它们谁都不关心的 prop。
 * App 启动时注册一次即可。
 */
let resolveFile: ((path: string) => string) | null = null;

export function setFileUrlResolver(fn: (path: string) => string): void {
  resolveFile = fn;
}

/** 这些 src 直接拿去加载,不当作电脑上的路径 */
const PASSTHROUGH = /^(https?|data|file|content):/i;

/**
 * 图片 src → 可加载的 uri。解析不出来时返回 null,调用方降级成链接文字。
 *
 * 两种情况要分开对待:远程地址原样保留(解码百分号会把 URL 里合法的 `%20`
 * 弄坏),而本地路径必须解码 —— markdown-it 会把 `E:\a.png` 编码成
 * `E:%5Ca.png`。
 */
export function imageUri(src: string): string | null {
  const raw = src.trim();
  if (!raw) return null;
  if (PASSTHROUGH.test(raw)) return raw;

  let local = raw;
  try {
    local = decodeURIComponent(raw);
  } catch {
    /* 编码坏了就用原样,让下面去决定怎么处理 */
  }
  return resolveFile ? resolveFile(local) : null;
}
