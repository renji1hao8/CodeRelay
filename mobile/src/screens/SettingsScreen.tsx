import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Api } from "../api";
import type { DeviceSummary, HealthResponse } from "../shared";
import {
  saveNotifyDisabled,
  saveServer,
  type StoredConfig,
} from "../storage";
import {
  ensureNotificationPermission,
  notifyStatus,
  postLocalNotification,
  startForegroundNotify,
  stopForegroundNotify,
  type NotifyStatus,
} from "../native/notify";
import { theme } from "../theme";
import { errText } from "../util";
import { Btn, Header, IconButton, Sheet } from "../components/ui";
import { AboutSection } from "./settings/AboutSection";
import { AuditSection } from "./settings/AuditSection";
import { AccountsSection } from "./settings/AccountsSection";
import { DangerSection } from "./settings/DangerSection";
import { DeviceSection } from "./settings/DeviceSection";
import { DownloadSection } from "./settings/DownloadSection";
import { LinkSection } from "./settings/LinkSection";
import { NotifySection } from "./settings/NotifySection";
import { PushSection } from "./settings/PushSection";
import { RecoverySection } from "./settings/RecoverySection";
import { settingsStyles as s } from "./settings/styles";
import type { AuditRow, EditTarget, Provider } from "./settings/types";

/**
 * 设置页。这里只做**编排**:拉数据、存数据、把状态分发给各区块。
 * 每个区块自己的样子和行为在 ./settings/ 下 —— 之前全挤在这一个文件里,
 * 865 行,想改"推送通道"的一行字得先滚过四屏别的设置。
 *
 * 反馈信息也按区块拆开了。原先所有区块共用一个 notice,而它渲染在「推送通道」那一节
 * 底部 —— 改了别处的设置,确认信息却出现在下面两屏之外,等于没有反馈。
 * 现在每一节就近显示自己的结果。
 */
export function SettingsScreen({
  api,
  config,
  onConfigChange,
  health,
  onRefreshHealth,
  onUnpaired,
  reloadToken = 0,
}: {
  api: Api;
  config: StoredConfig;
  onConfigChange: (patch: Partial<StoredConfig>) => void;
  health: HealthResponse | null;
  onRefreshHealth: () => Promise<void>;
  onUnpaired: () => void;
  /** 链路从"不通"恢复时由 App 递增。之前那次失败的请求不会自己重来,得给个明确的信号 */
  reloadToken?: number;
}) {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [provider, setProvider] = useState<Provider>("off");
  const [endpoint, setEndpoint] = useState("");
  const [topic, setTopic] = useState("");
  const [method, setMethod] = useState<"GET" | "POST">("POST");
  const [enabled, setEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [notify, setNotify] = useState<NotifyStatus>(() => notifyStatus());
  const [notifyBusy, setNotifyBusy] = useState(false);

  /** 各区块的就地反馈。见文件头的说明 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pushNotice, setPushNotice] = useState<string | null>(null);
  const [deviceNotice, setDeviceNotice] = useState<string | null>(null);
  const [notifyNotice, setNotifyNotice] = useState<string | null>(null);
  /** 编辑面板保存失败的提示,显示在面板自己身上 —— 面板一关就看不到原因了 */
  const [editError, setEditError] = useState<string | null>(null);

  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  const reload = useCallback(async () => {
    const [d, a, p] = await Promise.allSettled([api.devices(), api.audit(50), api.pushConfig()]);
    const failed: string[] = [];

    if (d.status === "fulfilled") setDevices(d.value);
    else failed.push("设备列表");

    if (a.status === "fulfilled") {
      setAudit(a.value.map((r) => ({ id: r.id, ts: r.ts, action: r.action, target: r.target, result: r.result })));
    } else failed.push("审计记录");

    if (p.status === "fulfilled") {
      setProvider((p.value.provider as Provider) ?? "off");
      setEndpoint(p.value.endpoint ?? "");
      setTopic(p.value.topic === "已配置" ? "" : (p.value.topic ?? ""));
      setMethod((p.value.method as "GET" | "POST") ?? "POST");
      setEnabled(Boolean(p.value.enabled));
    } else failed.push("推送配置");

    setLoadError(failed.length > 0 ? failed.join(" / ") : null);
    // `reloadToken` 不在函数体里出现,它是**故意的依赖**:值一变就重跑这一整段,见上面
  }, [api, reloadToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openEdit = (target: EditTarget) => {
    setEditDraft(target.value);
    setEditError(null);
    setEdit(target);
  };

  const commitEdit = async () => {
    if (!edit) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await edit.save(editDraft);
      setEdit(null);
    } catch (err) {
      // 面板留着,把原因显示在它自己身上 —— 直接关掉的话用户只看到"点了没反应"
      setEditError(errText(err));
    } finally {
      setEditBusy(false);
    }
  };

  /* ------------------------------------------------------------ 链路 -- */

  /**
   * 改电脑地址。
   *
   * 不需要重新配对 —— token 绑的是后端本身,不是地址。所以地址填错、或者换了服务器
   * 入口,在这里改一下就行(改完 api 会新建实例,拿的还是同一个 token)。
   */
  const saveServerUrl = async (next: string) => {
    const url = next.trim().replace(/\/+$/, "");
    if (!url) throw new Error("地址不能为空");
    if (!/^https?:\/\//i.test(url)) throw new Error("要以 http:// 或 https:// 开头");
    await saveServer(url);
    onConfigChange({ serverUrl: url });
  };

  /* ------------------------------------------------------------ 推送 -- */

  const savePush = async () => {
    setPushBusy(true);
    setPushNotice(null);
    try {
      await api.setPushConfig({ provider, endpoint, topic, method, enabled });
      setPushNotice("推送配置已保存");
      await reload();
    } catch (err) {
      setPushNotice(errText(err));
    } finally {
      setPushBusy(false);
    }
  };

  const testPush = async () => {
    setPushBusy(true);
    setPushNotice(null);
    try {
      const result = await api.pushTest();
      setPushNotice(result.sent ? "测试通知已发出,看手机通知栏" : `没发出去:${result.reason ?? "未知原因"}`);
    } catch (err) {
      setPushNotice(errText(err));
    } finally {
      setPushBusy(false);
    }
  };

  /* ------------------------------------------------------------ 设备 -- */

  const revokeDevice = async (id: string) => {
    setDeviceNotice(null);
    try {
      await api.revokeDevice(id);
      await reload();
    } catch (err) {
      setDeviceNotice(errText(err));
    }
  };

  /* ------------------------------------------------------------ 通知 -- */

  /** 开启常驻:先确认通知权限,再启动前台服务 */
  const enableForeground = async () => {
    setNotifyBusy(true);
    setNotifyNotice(null);
    try {
      const granted = await ensureNotificationPermission();
      if (!granted) {
        setNotifyNotice("系统没给通知权限,通知会被静默丢掉。用下面的按钮去开启。");
        setNotify(notifyStatus());
        return;
      }
      // 常驻服务是原生层直连后端的,所以要给它完整地址而不是相对路径
      const base = config.serverUrl;
      if (!base || !config.token) {
        setNotifyNotice("请先完成电脑配对。");
        return;
      }
      await startForegroundNotify(base, config.token);
      await saveNotifyDisabled(false);
      // 等服务把 WebSocket 连上再读状态,否则会显示成"没连上"
      await new Promise((r) => setTimeout(r, 1500));
      setNotify(notifyStatus());
    } catch (err) {
      setNotifyNotice(errText(err));
    } finally {
      setNotifyBusy(false);
    }
  };

  const disableForeground = async () => {
    setNotifyBusy(true);
    setNotifyNotice(null);
    try {
      await stopForegroundNotify();
      // 记下"是用户主动关的",别再被自动拉起
      await saveNotifyDisabled(true);
      await new Promise((r) => setTimeout(r, 600));
      setNotify(notifyStatus());
      setNotifyNotice("已关闭常驻连接。App 开着的时候仍然收得到消息。");
    } catch (err) {
      setNotifyNotice(errText(err));
    } finally {
      setNotifyBusy(false);
    }
  };

  const testLocalNotify = async () => {
    setNotifyNotice(null);
    const granted = await ensureNotificationPermission();
    if (!granted) {
      setNotifyNotice("系统没给通知权限。");
      setNotify(notifyStatus());
      return;
    }
    const ok = await postLocalNotification("CodeRelay 测试通知", "本地通知是通的", "remotecc://home");
    setNotify(notifyStatus());
    setNotifyNotice(ok ? "已弹出一条本地通知,看通知栏" : "没能弹出(可能被系统拦截)");
  };

  return (
    <View style={styles.page}>
      {/* 页眉固定在顶上(和文件页一致):滚下去之后还知道自己在哪一屏 */}
      <Header
        title="设置"
        subtitle={config.serverUrl?.replace(/^https?:\/\//, "") ?? undefined}
        right={
          <IconButton
            icon="refresh-outline"
            label="重新拉取设置"
            onPress={() => { void onRefreshHealth(); void reload(); }}
          />
        }
      />
      <ScrollView
        style={styles.root}
        contentContainerStyle={{ padding: theme.space(4), paddingBottom: theme.space(10) }}
      >
        {/* 整页数据的加载失败要放在最上面:它不属于任何单一区块,
            塞进某一节只会让人以为"只有那一节坏了"。⚠️ 要点名**是哪一个**没拿到 ——
            笼统一句"读取设置失败"会把使用者引到错的区块上去查 */}
        {loadError ? (
          <Text style={[s.error, styles.loadError]}>
            暂时无法更新：{loadError}。请稍后刷新。
          </Text>
        ) : null}

        <LinkSection
          config={config}
          health={health}
          notice={null}
          onEdit={openEdit}
          onSaveUrl={saveServerUrl}
          onRefreshHealth={onRefreshHealth}
        />

        <RecoverySection api={api} />

        <NotifySection
          notify={notify}
          busy={notifyBusy}
          notice={notifyNotice}
          onToggle={(v) => void (v ? enableForeground() : disableForeground())}
          onTestLocal={() => void testLocalNotify()}
        />

        <PushSection
          provider={provider}
          endpoint={endpoint}
          topic={topic}
          method={method}
          enabled={enabled}
          busy={pushBusy}
          notice={pushNotice}
          onProvider={setProvider}
          onEndpoint={setEndpoint}
          onTopic={setTopic}
          onMethod={setMethod}
          onEnabled={setEnabled}
          onSave={() => void savePush()}
          onTest={() => void testPush()}
          onEdit={openEdit}
        />

        <DownloadSection />

        <AccountsSection api={api} />

        <DeviceSection devices={devices} notice={deviceNotice} onRevoke={revokeDevice} />

        <AuditSection audit={audit} />
        <AboutSection api={api} />
        <DangerSection onUnpaired={onUnpaired} />
      </ScrollView>

      {/* 长串一律收成一行,点铅笔才弹这个输入面板 */}
      <Sheet visible={edit !== null} onClose={() => setEdit(null)} title={edit?.title} subtitle={edit?.hint}>
        <TextInput
          style={styles.input}
          value={editDraft}
          onChangeText={setEditDraft}
          placeholder={edit?.placeholder}
          placeholderTextColor={theme.color.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={edit?.secret}
          autoFocus
        />
        {editError ? <Text style={s.error}>{editError}</Text> : null}
        <Btn label="保存" kind="primary" full loading={editBusy} onPress={() => void commitEdit()} />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  /** 整页容器:页眉固定在上面,下面才是滚动区(文件页也是这个结构) */
  page: { flex: 1, backgroundColor: theme.color.bg },
  loadError: { paddingHorizontal: theme.space(4) },
  input: {
    backgroundColor: theme.color.codeBg,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    color: theme.color.text,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(3),
    fontSize: theme.font.size.md,
  },
});
