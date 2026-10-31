/** 推送通道的三选一 */
export type Provider = "off" | "ntfy" | "webhook";

/**
 * 正在编辑的那一个字段。
 *
 * 设置页里所有长串(网络 ID、token、推送地址)都收成一行,点铅笔才弹输入面板 ——
 * 这个对象就是那个面板的内容描述。`save` 由发起编辑的那一方给,
 * 因为落盘位置各不相同(有的存本机 SecureStore,有的存到电脑上)。
 */
export interface EditTarget {
  title: string;
  value: string;
  placeholder?: string;
  secret?: boolean;
  hint?: string;
  save: (next: string) => Promise<void> | void;
}

/**
 * 一条操作记录。
 *
 * 只取展示需要的字段,不是后端 AuditRecord 的完整形状 —— 后者还带 device_id 之类的
 * 内部字段,界面上用不到。
 */
export interface AuditRow {
  id: number;
  ts: string;
  action: string;
  target: string | null;
  result: string;
}
