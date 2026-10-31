/**
 * 全局事件流:给 App 的后台常驻服务用。
 *
 * 和 routes/stream.ts 的区别:那个是"某个会话的全部帧",按 runId 订阅;
 * 这个是"所有会话里值得惊动用户的事件",跨会话、只有通知级别的内容。
 * 后台服务只需要后者 —— 它不该为了弹一条通知而解析整个消息流。
 */

export type NotifyKind = "approval" | "done" | "error" | "test";

export interface NotifyEvent {
  t: "notify";
  kind: NotifyKind;
  title: string;
  body: string;
  /** 点通知时要打开的深链 */
  link: string;
  runId: string | null;
  ccSessionId: string | null;
  at: string;
}

export interface HelloEvent {
  t: "hello";
  at: string;
}

export type ServerEvent = NotifyEvent | HelloEvent;

type Listener = (event: NotifyEvent) => void;

const listeners = new Set<Listener>();

export function onEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function broadcastEvent(event: NotifyEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* 订阅者已断开,由其自身的 close 事件清理 */
    }
  }
}

export function eventSubscriberCount(): number {
  return listeners.size;
}
