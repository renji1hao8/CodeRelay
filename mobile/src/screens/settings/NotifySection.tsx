import { Text, View } from "react-native";
import { openNotificationSettings, type NotifyStatus } from "../../native/notify";
import { theme } from "../../theme";
import { IconButton, Section, SettingRow, SwitchRow } from "../../components/ui";
import { IconActionRow } from "./rows";
import { settingsStyles as s } from "./styles";

/**
 * 后台通知。
 *
 * 这一节讲的是「App 自己连着后端收通知」那条路 —— 和「推送通道」是两条独立通路:
 * 那条依赖电脑主动往外推,这条只需要 App 进程还活着(或常驻服务还在)。
 */
export function NotifySection({
  notify,
  busy,
  notice,
  onToggle,
  onTestLocal,
}: {
  notify: NotifyStatus;
  busy: boolean;
  notice: string | null;
  onToggle: (on: boolean) => void;
  onTestLocal: () => void;
}) {
  return (
    <Section title="后台通知">
      <View style={s.group}>
        <SwitchRow
          title="常驻连接"
          subtitle={
            notify.running
              ? notify.connected
                ? "已连接 · 通知栏有一条常驻通知"
                : "已启动,正在连接"
              : "关闭后 App 被系统回收就收不到通知"
          }
          value={notify.running}
          disabled={!notify.available || busy}
          onValueChange={onToggle}
        />
        <SettingRow
          title="通知权限"
          subtitle={notify.canPost ? "已授予" : "没给权限的话通知会被静默丢掉"}
          right={
            <IconButton
              icon={notify.canPost ? "checkmark-circle" : "alert-circle-outline"}
              onPress={() => void openNotificationSettings()}
              color={notify.canPost ? theme.color.ok : theme.color.warn}
              size={19}
            />
          }
        />
        <IconActionRow
          title="本地通知"
          subtitle="发送一条测试通知"
          icon="notifications-outline"
          iconLabel="试一条通知"
          onPress={onTestLocal}
        />
        {notify.available ? null : <SettingRow title="通知模块" subtitle="当前版本不支持后台通知" />}
        {notify.lastError ? <SettingRow title="最近错误" subtitle={notify.lastError} /> : null}
        {notice ? <Text style={s.notice}>{notice}</Text> : null}
      </View>
    </Section>
  );
}
