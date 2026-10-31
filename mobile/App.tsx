import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import type { IconName } from "./src/components/ui";
import { Api, ApiError } from "./src/api";
import { clearToken, loadConfig, loadNotifyDisabled, saveToken, type StoredConfig } from "./src/storage";
import { clearAll as clearCache } from "./src/cache";
import { setFileUrlResolver } from "./src/markdown";
import type { ChatMessage, HealthResponse, PermissionMode } from "./src/shared";
import {
  clearEventNotifications,
  ensureNotificationPermission,
  notifyStatus,
  startForegroundNotify,
} from "./src/native/notify";
import { theme } from "./src/theme";
import { PairScreen } from "./src/screens/PairScreen";
import { parseDeepLink } from "./src/deepLink";
import { SessionsTab } from "./src/screens/SessionsTab";
import { ErrorBoundary } from "./src/components/ErrorBoundary";
import { ChatScreen } from "./src/screens/ChatScreen";
import { FilesScreen } from "./src/screens/FilesScreen";
import { ShellScreen } from "./src/screens/ShellScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { KeyboardProvider, KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";

type Tab = "sessions" | "shell" | "files" | "settings";

/**
 * 顺序即位置(底部那一栏照着这个数组画)。
 *
 * ⚠️ 「命令」排第二是使用者点名的:它左边是「会话」、右边是「文件」——
 * 也就是"最常用的那两样夹着它"。
 */
const TABS: { key: Tab; label: string; icon: IconName; iconActive: IconName }[] = [
  { key: "sessions", label: "会话", icon: "chatbubbles-outline", iconActive: "chatbubbles" },
  { key: "shell", label: "命令", icon: "terminal-outline", iconActive: "terminal" },
  { key: "files", label: "文件", icon: "folder-outline", iconActive: "folder" },
  { key: "settings", label: "设置", icon: "settings-outline", iconActive: "settings" },
];

export interface LiveChat {
  /**
   * 后端那个 claude 进程的 id。
   *
   * `null` 表示**还在起** —— 页面已经用 history 铺上了,但流还没接上,
   * 这时不能发消息。见 SessionsScreen.openSession 的两段式打开。
   */
  runId: string | null;
  title: string;
  /**
   * 这条会话的权限模式。
   *
   * ⚠️ 用 `PermissionMode` **别写死字面量联合**:这里原来写死了
   * `"readonly" | "acceptEdits" | "ask"`,于是加第四个档位时 TS 会在三个调用点上
   * 报"bypass 不能赋给它" —— 而那不是错误,是这个类型过时了。
   */
  mode: PermissionMode;
  /** 续接历史会话时,把已加载的历史带进聊天页当作初始消息 */
  seed?: ChatMessage[];
  /**
   * 那份 seed 的「更早的一页」游标。
   *
   * ⚠️ 首屏只给 60 条(见服务端的 `MESSAGE_PAGE`),所以**老消息只能靠它翻上去** ——
   * 不带的话,聊天页里比 60 条更早的内容就永远看不到了。
   */
  seedOlderCursor?: number | null;
  /**
   * 复用一个当时正在跑一轮的会话。让聊天页一进去就显示"正在…",
   * 否则要等第一帧到达才知道,中间那一下会显示成空闲,像是没接上。
   */
  reusedBusy?: boolean;
}

/**
 * 顶部那条提示。
 *
 * 链路收敛到公网隧道之后要分的情况少了很多 —— 不再有"组网没起来/组网掉线/
 * 组网没授权"这些分支,剩下的主要就是**连不上电脑**这一种。
 * 出问题时先看设置页的「链路」一节:隧道通了不代表后端在跑,两件事分开看才排得动。
 */
function statusHint(
  reachable: boolean | null,
  health: HealthResponse | null,
): { text: string; tone: "danger" | "warn" } | null {
  if (reachable === false) {
    return {
      text: "暂时无法连接电脑，请检查网络或在设置中重新连接",
      tone: "danger",
    };
  }
  return null;
}

function Shell() {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState(state => state.isVisible);
  const [config, setConfig] = useState<StoredConfig | null>(null);
  const [tab, setTab] = useState<Tab>("sessions");
  const [chat, setChat] = useState<LiveChat | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [pendingLink, setPendingLink] = useState<{ kind: "cc" | "run" | "codex"; id: string } | null>(null);
  /**
   * 深链要打开的 **Codex** 会话 id。
   *
   * ⚠️ 为什么不像 Claude 那样直接 `setChat`:Codex 的会话页挂在**会话 tab 里面**
   * (见 `SessionsTab`),所以这里只能"把 tab 切过去 + 把这条例会话交给它"。
   */
  const [pendingCodex, setPendingCodex] = useState<string | null>(null);
  const [pendingClaude, setPendingClaude] = useState<string | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);

  const api = useMemo(() => {
    if (!config) return null;
    // 只有一条链路:公网隧道入口。地址在配对时写入,之后不再变
    const baseUrl = config.serverUrl;
    return baseUrl ? new Api({ baseUrl, token: config.token }) : null;
  }, [config?.serverUrl, config?.token]);
  const currentApi = useRef(api);
  currentApi.current = api;

  // markdown 里的本地图片路径要靠 Api 换成带 token 的下载地址。注册在这里而不是
  // 把 api 层层透传到 Markdown —— 中间有四五个组件,它们谁都不关心这件事。
  // 详见 src/markdown/resolver.ts。
  useEffect(() => {
    setFileUrlResolver((path) => (api ? api.fileUrl(path, true) : ""));
  }, [api]);

  useEffect(() => {
    void loadConfig().then(setConfig);
  }, []);

  /**
   * 连续失败几次才算"链路不通"。
   *
   * ⚠️ 一次失败就翻成"不通"会引发一串连锁反应,而它的起因通常只是一次抖动:
   * 不通 → 轮询从 20 秒改成 2 秒 → 很快又成功 → reachable 走一遍 false→true →
   * reloadToken +1 → **所有页面重拉一遍**。使用者看到的就是"切个后台回来,
   * 什么都在重新加载"。所以要求连续失败到阈值才认。
   */
  const failStreak = useRef(0);
  const FAILS_BEFORE_DOWN = 2;
  useEffect(() => { failStreak.current = 0; setHealth(null); setReachable(null); }, [api]);

  const refreshHealth = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api.health();
      if (currentApi.current !== api) return;
      setHealth(next);
      failStreak.current = 0;
      setReachable(true);
    } catch {
      if (currentApi.current !== api) return;
      failStreak.current += 1;
      // 没到阈值就什么都不做:保留上一份 health,界面不闪
      if (failStreak.current >= FAILS_BEFORE_DOWN) {
        setHealth(null);
        setReachable(false);
      }
    }
  }, [api]);

  // 不通的时候要盯紧一点。组网刚恢复的那一下是黄金时间 —— 20 秒才试一次的话,
  // 用户会以为"还是连不上",然后去做没必要的手动操作。
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refreshHealth();
      if (!stopped) timer = setTimeout(() => void poll(), failStreak.current ? 2000 : 20000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refreshHealth]);

  // reachable 从"不通"翻到"通"= 链路刚恢复。各页面之前那次失败的请求不会自己重来,
  // 得给它们一个明确的重载信号,否则界面会一直停在失败状态,看着像没恢复。
  const [reloadToken, setReloadToken] = useState(0);
  const prevReachableRef = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = prevReachableRef.current;
    prevReachableRef.current = reachable;
    if (prev === false && reachable === true) setReloadToken((n) => n + 1);
  }, [reachable]);

  /**
   * App 回到前台时的一次性探测。
   *
   * Android 会在后台冻结整个进程,而 nginx 与 frpc 那条长连接会被中间设备回收 ——
   * 回到前台时它大概率已经坏了,但本地并不知情(WebSocket 要等超时才报错)。
   * 所以主动探一次,别让界面挂着"已连接"却什么都发不出去。
   *
   * 探失败**不直接判定不通**:刚回到前台时网卡常常还没醒,那一下失败是常态。
   * 真不通的话,定时轮询会在连续失败到阈值后把状态翻过去。
   */
  const probeOnResume = useCallback(async () => {
    await refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void probeOnResume();
        // 回到前台 = "那些说'有结果可以看了'的提醒我看到了",把这一类通知收掉。
        // **只清 done/error,不动 approval** —— 还没处理的审批不该被悄悄抹掉,
        // 它得留在通知栏里直到使用者真的做了决定。
        void clearEventNotifications("done");
      }
    });
    return () => sub.remove();
  }, [probeOnResume]);

  /**
   * 常驻连接默认开着。
   *
   * 它是"App 被系统回收之后还能收到通知"的唯一途径 —— 关着的话,手机一锁屏久了
   * 就什么都收不到,而使用者看不出是 App 没在跑。代价只是通知栏多一条常驻通知,
   * 这个是 Android 对前台服务的硬性要求,去不掉但至少是明摆着的。
   *
   * 用户手动关过就记下来,不再自动拉起(否则那个开关等于摆设)。
   */
  const notifyAutoTried = useRef(false);
  useEffect(() => {
    if (notifyAutoTried.current || !config?.token) return;
    notifyAutoTried.current = true;

    void (async () => {
      try {
        const status = notifyStatus();
        if (!status.available || status.running) return;
        if (await loadNotifyDisabled()) return;
        const base = config.serverUrl;
        if (!base) return;
        // 没给通知权限就别开 —— 那样只会白留一条弹不出来的常驻通知
        if (!(await ensureNotificationPermission())) return;
        await startForegroundNotify(base, config.token!);
      } catch {
        // 常驻起不来不影响 App 本身,设置页里还能手动开
      }
    })();
  }, [config]);

  // 通知点进来:remotecc://session/cc/<CC会话id> · .../run/<runId> · .../codex/<Codex thread id>
  useEffect(() => {
    const handle = (url: string | null | undefined) => {
      // 判据在 `deepLink.ts` —— 它是纯函数,有用例钉着(通知点不开是"看着像好了"的那类毛病)
      const link = parseDeepLink(url ?? null);
      if (link) setPendingLink(link);
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", (event) => handle(event.url));
    return () => sub.remove();
  }, []);

  // 深链要等 api 就绪才能解析;CC 的 sessionId 还需要换成一个活着的 runId
  useEffect(() => {
    if (!api || !pendingLink) return;
    const link = pendingLink;
    setPendingLink(null);

    void (async () => {
      try {
        if (link.kind === "codex") {
          // Codex 那条会话页在会话 tab 里面 —— 切过去,再把 id 交给它去开
          setTab("sessions");
          setPendingCodex(link.id);
          return;
        }
        if (link.kind === "run") {
          setChat({ runId: link.id, title: "来自通知的会话", mode: "ask" });
          return;
        }
        // A notification must not silently start an independent CLI writer.
        setTab("sessions");
        setPendingClaude(link.id);
      } catch {
        // 会话可能已被回收或正在桌面版里活跃,退回会话列表让用户自己选
        setTab("sessions");
      }
    })();
  }, [api, pendingLink]);

  const onPaired = useCallback(async (token: string) => {
    await saveToken(token);
    // 换了后端就把上个后端的数据丢掉,免得把别人的会话列表当自己的显示出来
    clearCache();
    setConfig((prev) => (prev ? { ...prev, token } : prev));
  }, []);

  const hint = config ? statusHint(reachable, health) : null;

  if (!config) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>正在读取本地配置…</Text>
      </View>
    );
  }

  if (!config.serverUrl || !config.token) {
    return (
      <PairScreen
        initialServer={config.serverUrl ?? ""}
        deviceName={config.deviceName}
        onSaved={(patch) => setConfig((prev) => (prev ? { ...prev, ...patch } : prev))}
        onPaired={onPaired}
      />
    );
  }

  if (!api) return null;

  if (chat) {
    return (
      <ErrorBoundary label="对话页">
        <ChatScreen
          api={api}
          live={chat}
        onClose={() => {
          setChat(null);
          setTab("sessions");
        }}
          // 会话被回收/后端重启过之后,钩子会自己 resume 一条新的并把 runId 交上来换掉
          onRunIdChange={(runId) => setChat((c) => (c ? { ...c, runId } : c))}
          // 改完会话名,把头部标题一起换掉(名字的真身在电脑上那个会话文件里)
          onTitleChange={(title) => setChat((c) => (c ? { ...c, title } : c))}
        />
      </ErrorBoundary>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar style="light" />
      {hint ? (
        <View style={[styles.banner, hint.tone === "warn" && styles.bannerWarn]}>
          <Ionicons
            name={hint.tone === "warn" ? "warning-outline" : "alert-circle-outline"}
            size={15}
            color={hint.tone === "warn" ? theme.color.warn : theme.color.danger}
          />
          <Text style={[styles.bannerText, hint.tone === "warn" && styles.bannerTextWarn]}>{hint.text}</Text>
        </View>
      ) : null}

      {/*
        ⚠️ 每个 tab 各包一层兜底:渲染期抛异常在 RN 里**直接杀进程**,而"某一屏的数据形状
        不对"不该有这种代价(2026-09-19 因此崩了两次)。
      */}
      <View style={styles.body}>
        {tab === "sessions" ? (
          <ErrorBoundary label="会话页">
            <SessionsTab
              api={api}
              onOpenLive={setChat}
              reloadToken={reloadToken}
              pendingCodexThreadId={pendingCodex}
              pendingClaudeSessionId={pendingClaude}
              onPendingCodexConsumed={() => { setPendingCodex(null); setPendingClaude(null); }}
            />
          </ErrorBoundary>
        ) : null}
        {tab === "shell" ? (
          <ErrorBoundary label="命令页">
            <ShellScreen api={api} />
          </ErrorBoundary>
        ) : null}
        {tab === "files" ? (
          <ErrorBoundary label="文件页">
            <FilesScreen api={api} reloadToken={reloadToken} />
          </ErrorBoundary>
        ) : null}
        {tab === "settings" ? (
          <ErrorBoundary label="设置页">
            <SettingsScreen
              api={api}
              config={config}
              reloadToken={reloadToken}
              onConfigChange={(patch) => setConfig((prev) => (prev ? { ...prev, ...patch } : prev))}
              health={health}
              onRefreshHealth={refreshHealth}
              onUnpaired={() => {
                // 先把 token 从 SecureStore 删干净再改界面状态。
                // 删失败就维持原状 —— 只改内存的话冷启动 token 会自己回来,
                // 而用户以为已经解除了,那是更糟的结果。
                void clearToken()
                  .then(() => {
                    clearCache();
                    setConfig((prev) => (prev ? { ...prev, token: null } : prev));
                  })
                  .catch(() => {
                    /* 写 SecureStore 失败:保持已配对状态,下次再试 */
                  });
              }}
            />
          </ErrorBoundary>
        ) : null}
      </View>

      <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 8), display: keyboardVisible ? "none" : "flex" }]}>
        {TABS.map((item) => {
          const active = item.key === tab;
          return (
            <Pressable
              key={item.key}
              style={({ pressed }) => [styles.tab, pressed && { opacity: 0.6 }]}
              onPress={() => setTab(item.key)}
            >
              <Ionicons
                name={active ? item.iconActive : item.icon}
                size={22}
                color={active ? theme.color.accent : theme.color.textFaint}
              />
              <Text style={[styles.tabLabel, active && styles.tabActive]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider preload={false}>
        <KeyboardAvoidingView style={styles.root} behavior="height" automaticOffset>
          <Shell />
        </KeyboardAvoidingView>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  body: { flex: 1 },
  loading: { flex: 1, backgroundColor: theme.color.bg, alignItems: "center", justifyContent: "center" },
  loadingText: { color: theme.color.textDim },
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.space(2),
    backgroundColor: theme.color.dangerSoft,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3),
  },
  bannerWarn: { backgroundColor: theme.color.warnSoft },
  bannerText: { color: theme.color.danger, fontSize: theme.font.size.sm, lineHeight: 19, flex: 1 },
  bannerTextWarn: { color: theme.color.warn },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border,
    backgroundColor: theme.color.surface,
    paddingTop: theme.space(2),
  },
  tab: { flex: 1, alignItems: "center", gap: 3 },
  tabLabel: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  tabActive: { color: theme.color.accent, fontWeight: theme.font.weight.semibold },
});
