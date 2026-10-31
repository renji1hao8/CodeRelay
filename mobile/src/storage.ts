import * as SecureStore from "expo-secure-store";
import type { PriceRule } from "./billing";
import { isPermissionMode, type PermissionMode } from "./shared";

const KEY_SERVER = "remotecc.server";
const KEY_TOKEN = "remotecc.token";
const KEY_DEVICE = "remotecc.deviceName";
const KEY_NOTIFY_OFF = "remotecc.notifyDisabled";
const KEY_DOWNLOAD_DIR = "remotecc.downloadDir";

// SecureStore 里可能还留着 remotecc.connectionMode / remotecc.networkId —— 那是
// 内置组网时代的配置。现在只有一条链路(公网隧道),这两个键没有意义了。
// 不去删它们:无害,而且删了反而多一次读写。

export interface StoredConfig {
  serverUrl: string | null;
  token: string | null;
  deviceName: string;
}

export async function loadConfig(): Promise<StoredConfig> {
  const [serverUrl, token, deviceName] = await Promise.all([
    SecureStore.getItemAsync(KEY_SERVER),
    SecureStore.getItemAsync(KEY_TOKEN),
    SecureStore.getItemAsync(KEY_DEVICE),
  ]);
  return {
    serverUrl,
    token,
    deviceName: deviceName ?? "",
  };
}

export async function saveServer(url: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_SERVER, url.replace(/\/+$/, ""));
}

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_TOKEN, token);
}

export async function saveDeviceName(name: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_DEVICE, name);
}

/**
 * 用户是不是主动关掉过常驻连接。
 *
 * 常驻连接默认是开的,所以必须把"我不想开"这个意图记下来 —— 否则下次冷启动
 * 又会被自动拉起来,那个开关就成了摆设。
 */
export async function saveNotifyDisabled(disabled: boolean): Promise<void> {
  if (disabled) await SecureStore.setItemAsync(KEY_NOTIFY_OFF, "1");
  else await SecureStore.deleteItemAsync(KEY_NOTIFY_OFF);
}

export async function loadNotifyDisabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(KEY_NOTIFY_OFF)) === "1";
}

/**
 * 下载目录(SAF 目录树 URI)。
 *
 * ⚠️ 为什么必须记下来:Android 10+ 的分区存储不允许 App 直接写 `/sdcard/Download`,
 * 唯一没 root 也能把文件放进"文件管理器看得见的地方"的官方途径是 SAF —— 让使用者
 * **自己选一个目录**。而选目录那个系统弹窗每下一个小文件就弹一次,没人受得了。
 *
 * 好在 SAF 的授权是**可持久化**的(expo 的实现里调了 `takePersistableUriPermission`,
 * 带 READ|WRITE),所以选一次就够了 —— 这就是"默认下载文件夹"的由来。
 *
 * 选错/授权失效怎么办:见 download.ts,那里会在写失败时清掉这个键并重新问一次。
 */
export async function loadDownloadDir(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_DOWNLOAD_DIR);
}
export async function saveDownloadDir(uri: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_DOWNLOAD_DIR, uri);
}

export async function clearDownloadDir(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_DOWNLOAD_DIR);
}

/**
 * **上次**发图选的档位(档位定义在 imagePick.ts 的 IMAGE_TIERS)。
 *
 * ⚠️ 这不是"设置项":档位是**每张图问一次**的(见 ImageTierSheet)。把它存下来只为
 * 下次那张卡片的**预选**,让人少点一下。
 *
 * ⚠️ 存**字符串 id**,不存索引:档位以后增删或换顺序的话,索引会指到别的档上。
 * id 认不出来由 `tierOf()` 退回默认档,所以这里不必校验。
 */
const KEY_IMAGE_TIER = "remotecc.imageTier";

export async function loadImageTier(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_IMAGE_TIER);
}
export async function saveImageTier(id: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_IMAGE_TIER, id);
}

/**
 * **上次**用的权限模式。
 *
 * ⚠️ 存在的理由是一个真 bug(2026-09-20 使用者反馈「每次重进对话都会默认回到每步问」):
 * 会话页那个 `mode` 是**组件内的 state**,而三个 tab 是条件渲染(切走即卸载);
 * 更要命的是续接会话时 `POST /api/sessions/:id/resume` 不带 mode 的话,后端是
 * `body?.mode ?? "ask"` —— 于是**每次重进都落回「每步问」**,你在里面改过的模式
 * 下次进来又没了。
 *
 * 所以把"上次选的"记下来,新开会话和续接会话都拿它当默认值。
 *
 * ⚠️ 这只是**默认值**,不是"锁死":服务端每次接入都会推一帧 `mode_changed` 真值覆盖
 * 界面(见 routes/stream.ts),所以进了对话之后以那一帧为准。
 */
const KEY_LAST_MODE = "remotecc.lastMode";

/** 认不出来的值(老版本残留、手改过的 SecureStore)一律给 null,由调用方退回默认档 */
export async function loadLastMode(): Promise<PermissionMode | null> {
  const raw = await SecureStore.getItemAsync(KEY_LAST_MODE);
  return isPermissionMode(raw) ? raw : null;
}
export async function saveLastMode(mode: PermissionMode): Promise<void> {
  await SecureStore.setItemAsync(KEY_LAST_MODE, mode);
}

/**
 * 解除配对:删掉 token。
 *
 * 只删 token —— 服务器地址和设备名不是凭据,留着能让重新配对少填几项。
 *
 * ⚠️ 这个函数是补一个真 bug 的:以前「解除配对」只清了内存缓存(见 App.tsx 的
 * clearCache)和内存里的 config.token,SecureStore 里的 token 从没被删过。
 * 表现是解除当下看起来生效了,但**冷启动又会自动配对回去**。
 */
export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_TOKEN);
}

/**
 * 读一个存在 SecureStore 里的 JSON 数组。
 *
 * ⚠️ **「没存过」和「读不出来」必须分得开。** 两者都回 `[]` 的话,界面上就只剩一句
 * "还没配价",而使用者明明是配过的 —— 他会以为自己记错了、或者以为这个功能坏了,
 * 然后**重配一遍,把坏掉的那份覆盖掉**。而读不出来往往只是 JSON 里有一个字符坏了,
 * 那一份本来是能人工救回来的。所以读不出来时回 `null`,由调用方明说。
 */
async function loadJsonArray<T>(key: string): Promise<T[] | null> {
  const raw = await SecureStore.getItemAsync(key);
  if (!raw) return []; // 从来没存过 —— 这才是真的"还没配"
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null; // 存过,但现在解析不出来
  }
}

const KEY_PRICE_RULES = "remotecc.priceRules";

/**
 * 账单的计价规则。**`null` = 存过、但读不出来**(不是"没配过",见 loadJsonArray)。
 *
 * ⚠️ 放 SecureStore 是因为**这里的所有键都在这个文件里**(一条约定,别开第二个存储)。
 * 但它在 Android 上单值有 2KB 上下的限制,超了会**静默存不进去** —— 表现是"我明明配了
 * 价,下次进来又没了",而且完全没有任何提示。所以两道防线:
 *   1. 条数上限(见 billing.ts 的 MAX_RULES),界面上挡住
 *   2. 写完**读回来核对一遍**,对不上就明说
 */
export async function loadPriceRules(): Promise<PriceRule[] | null> {
  return loadJsonArray<PriceRule>(KEY_PRICE_RULES);
}

const KEY_HOLIDAYS = "remotecc.holidays";

/**
 * 法定节假日名单(本地日期 `YYYY-MM-DD`)。**`null` = 存过、但读不出来**(同上)。
 *
 * ⚠️ 单独一个键、不并进 priceRules:两个键各自都小,合起来就顶到 SecureStore 那 2KB 的
 * 单值上限了(12 条规则已经占掉一千多字节)。核对逻辑和规则那套一样。
 */
export async function loadHolidays(): Promise<string[] | null> {
  const list = await loadJsonArray<unknown>(KEY_HOLIDAYS);
  return list === null ? null : list.filter((d): d is string => typeof d === "string");
}

/** 存节假日。**返回 false 表示没存住** */
export async function saveHolidays(days: string[]): Promise<boolean> {
  const raw = JSON.stringify(days);
  await SecureStore.setItemAsync(KEY_HOLIDAYS, raw);
  return (await SecureStore.getItemAsync(KEY_HOLIDAYS)) === raw;
}

/** 存规则。**返回 false 表示没存住**(多半是超了 SecureStore 的单值上限) */
export async function savePriceRules(rules: PriceRule[]): Promise<boolean> {
  const raw = JSON.stringify(rules);
  await SecureStore.setItemAsync(KEY_PRICE_RULES, raw);
  const back = await SecureStore.getItemAsync(KEY_PRICE_RULES);
  return back === raw;
}
