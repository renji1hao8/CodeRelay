import { Alert, Text, View } from "react-native";
import type { DeviceSummary } from "../../shared";
import { theme } from "../../theme";
import { Empty, IconButton, Section, SettingRow, formatTime } from "../../components/ui";
import { settingsStyles as s } from "./styles";

/**
 * 已配对设备。
 *
 * 只列**还有效**的那些。已吊销的留在数据里是有用的(审计记录要引用 device_id,
 * 能查出"那次操作是哪台做的"),但摆在这里纯属噪音 —— 用户看到一排「已吊销」
 * 只会想删掉它们。
 */
export function DeviceSection({
  devices,
  notice,
  onRevoke,
}: {
  devices: DeviceSummary[];
  notice: string | null;
  onRevoke: (id: string) => Promise<void>;
}) {
  const active = devices.filter((d) => !d.revoked);

  return (
    <Section title="已配对设备">
      <View style={s.group}>
        {active.length === 0 ? (
          <Empty text="还没有其他设备" />
        ) : (
          active.map((d) => (
            <SettingRow
              key={d.id}
              title={d.name}
              subtitle={`配对于 ${formatTime(d.createdAt)} · 最近 ${formatTime(d.lastSeenAt)}`}
              right={
                <IconButton
                  icon="trash-outline"
                  color={theme.color.danger}
                  size={18}
                  label="吊销设备"
                  onPress={() =>
                    Alert.alert("吊销设备", `吊销后「${d.name}」需要重新配对`, [
                      { text: "取消", style: "cancel" },
                      { text: "吊销", style: "destructive", onPress: () => void onRevoke(d.id) },
                    ])
                  }
                />
              }
            />
          ))
        )}
        {notice ? <Text style={s.notice}>{notice}</Text> : null}
      </View>
    </Section>
  );
}
