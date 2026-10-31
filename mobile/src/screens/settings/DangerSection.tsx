import { Alert, View } from "react-native";
import { Btn, Section, SettingRow } from "../../components/ui";
import { settingsStyles as s } from "./styles";

/** 危险操作。单独成节,和上面那些"怎么调"的设置隔开 */
export function DangerSection({ onUnpaired }: { onUnpaired: () => void }) {
  return (
    <Section title="危险操作">
      <View style={s.group}>
        <SettingRow
          title="解除配对"
          subtitle="清掉这台手机上的 token,之后要重新生成配对码"
          right={
            <Btn
              label="解除"
              kind="danger"
              small
              onPress={() =>
                Alert.alert("解除配对", "确定要清除本机的登录凭据吗?", [
                  { text: "取消", style: "cancel" },
                  { text: "解除", style: "destructive", onPress: onUnpaired },
                ])
              }
            />
          }
        />
      </View>
    </Section>
  );
}
