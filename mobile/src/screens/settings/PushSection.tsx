import { Text, View } from "react-native";
import { Btn, CopyRow, Section, SettingRow, SwitchRow } from "../../components/ui";
import { ChoiceRow, IconActionRow } from "./rows";
import { settingsStyles as s } from "./styles";
import type { EditTarget, Provider } from "./types";

/**
 * 推送通道。服务端把会话事件推到 ntfy 或自建 webhook ——
 * 和「后台通知」那条路是两回事:那条是 App 自己连着后端收,这条是电脑主动往外推。
 */
export function PushSection({
  provider,
  endpoint,
  topic,
  method,
  enabled,
  busy,
  notice,
  onProvider,
  onEndpoint,
  onTopic,
  onMethod,
  onEnabled,
  onSave,
  onTest,
  onEdit,
}: {
  provider: Provider;
  endpoint: string;
  topic: string;
  method: "GET" | "POST";
  enabled: boolean;
  busy: boolean;
  notice: string | null;
  onProvider: (v: Provider) => void;
  onEndpoint: (v: string) => void;
  onTopic: (v: string) => void;
  onMethod: (v: "GET" | "POST") => void;
  onEnabled: (v: boolean) => void;
  onSave: () => void;
  onTest: () => void;
  onEdit: (target: EditTarget) => void;
}) {
  return (
    <Section title="推送通道">
      <View style={s.group}>
        <SwitchRow
          title="启用推送"
          subtitle="服务端把事件推到 ntfy 或你自己的 webhook"
          value={enabled}
          onValueChange={onEnabled}
        />
        <ChoiceRow
          title="通道"
          value={provider}
          onChange={onProvider}
          options={[
            { key: "off" as const, label: "关闭" },
            { key: "ntfy" as const, label: "ntfy" },
            { key: "webhook" as const, label: "webhook" },
          ]}
        />
        <CopyRow
          label="地址"
          value={endpoint || "未设置"}
          mono={false}
          onEdit={() =>
            onEdit({
              title: "推送地址",
              value: endpoint,
              placeholder:
                provider === "ntfy" ? "https://ntfy.sh 或自建地址" : "https://example.com/push?title={title}",
              save: onEndpoint,
            })
          }
        />
        {provider === "ntfy" ? (
          <CopyRow
            label="Topic"
            value={topic || "未设置"}
            mono={false}
            onEdit={() =>
              onEdit({
                title: "ntfy Topic",
                value: topic,
                placeholder: "一个别人猜不到的字符串",
                save: onTopic,
              })
            }
          />
        ) : null}
        {provider === "webhook" ? (
          <ChoiceRow
            title="方法"
            value={method}
            onChange={onMethod}
            options={[
              { key: "POST" as const, label: "POST" },
              { key: "GET" as const, label: "GET" },
            ]}
          />
        ) : null}
        <SettingRow
          title="保存配置"
          subtitle="改动就存在电脑上,不跟着 App 走"
          right={<Btn label="保存" kind="primary" small loading={busy} onPress={onSave} />}
        />
        <IconActionRow
          title="测试推送"
          subtitle="按当前配置发一条,看手机收不收得到"
          icon="paper-plane-outline"
          iconLabel="测试推送"
          onPress={onTest}
        />
        {notice ? <Text style={s.notice}>{notice}</Text> : null}
      </View>
    </Section>
  );
}
