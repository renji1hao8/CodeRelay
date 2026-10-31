import { requireNativeModule } from "expo";
import { PermissionsAndroid, Platform } from "react-native";

/**
 * 后台通知(原生模块 RemoteCcNotify)的 JS 侧契约。
 *
 * 分两层:
 *   1. 本地通知 —— App 还活着时,事件到了就弹一条。不需要任何常驻服务
 *   2. 常驻服务 —— 一条前台服务维持到后端 /api/events 的 WebSocket,
 *      这样 App 被系统回收后仍能收到。代价是通知栏里会有一条常驻通知
 *
 * 和组网模块一样,原生模块不存在时也要能优雅降级(Expo Go 里跑不了)。
 */

export interface NotifyStatus {
  available: boolean;
  running: boolean;
  connected: boolean;
  canPost: boolean;
  lastError: string | null;
}

interface NotifyNativeModule {
  getStatus(): Omit<NotifyStatus, "available">;
  start(baseUrl: string, token: string): Promise<void>;
  stop(): Promise<void>;
  notify(title: string, body: string, link: string | null, kind: string | null): Promise<boolean>;
  clearEvents(kind: string | null): Promise<void>;
  openNotificationSettings(): Promise<void>;
}

const UNAVAILABLE: NotifyStatus = {
  available: false,
  running: false,
  connected: false,
  canPost: false,
  lastError: null,
};

let cached: NotifyNativeModule | null = null;
let loadError: string | null = null;

function native(): NotifyNativeModule | null {
  if (cached) return cached;
  if (loadError) return null;
  try {
    cached = requireNativeModule<NotifyNativeModule>("RemoteCcNotify");
    return cached;
  } catch (err) {
    loadError = String(err);
    return null;
  }
}

export function notifyStatus(): NotifyStatus {
  const mod = native();
  if (!mod) return { ...UNAVAILABLE, lastError: "通知模块未加载(需要 dev build)" };
  try {
    return { ...mod.getStatus(), available: true };
  } catch (err) {
    return { ...UNAVAILABLE, available: true, lastError: String(err) };
  }
}

/**
 * API 33 起没有 POST_NOTIFICATIONS 授权,通知会被系统静默丢弃。
 * 这里只用 React Native 自带的 PermissionsAndroid,原生模块里不再重复实现。
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  if (typeof Platform.Version === "number" && Platform.Version < 33) return true;
  try {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

export async function startForegroundNotify(baseUrl: string, token: string): Promise<void> {
  const mod = native();
  if (!mod) throw new Error("通知模块未加载,当前构建不支持后台常驻");
  await mod.start(baseUrl, token);
}

export async function stopForegroundNotify(): Promise<void> {
  const mod = native();
  if (!mod) return;
  await mod.stop();
}

/** 弹一条本地通知。返回 false 说明没权限或被系统丢弃 */
export async function postLocalNotification(
  title: string,
  body: string,
  link: string | null,
  /** 与后端的 NotifyKind 同域。默认按"测试通知"归类 */
  kind: string | null = "test",
): Promise<boolean> {
  const mod = native();
  if (!mod) return false;
  try {
    return await mod.notify(title, body, link, kind);
  } catch {
    return false;
  }
}

/**
 * 收掉通知栏里那些已经处理过的事件通知。
 *
 * 存在的理由:`setAutoCancel` 只在"点击通知本身"那一下生效,而从 App 里进去审批/查看
 * 是碰不到那一次的 —— 于是那些提醒会一直赖在通知栏里(见 Notifications.kt 的 id 分区说明)。
 *
 * `kind` 与后端 NotifyKind 同域("approval" / "done" / "error" / "test"),传 null 全清。
 * 常驻那条永远不动 —— 它是前台服务的硬性要求。
 */
export async function clearEventNotifications(kind: string | null = null): Promise<void> {
  const mod = native();
  if (!mod || typeof mod.clearEvents !== "function") return;
  try {
    await mod.clearEvents(kind);
  } catch {
    // 清不掉是小事,不该因此打扰使用者
  }
}

export async function openNotificationSettings(): Promise<void> {
  const mod = native();
  if (!mod) return;
  await mod.openNotificationSettings();
}
