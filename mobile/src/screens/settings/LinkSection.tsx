import { StyleSheet, Text, View } from "react-native";
import type { HealthResponse } from "../../shared";
import type { StoredConfig } from "../../storage";
import { theme } from "../../theme";
import { CopyRow, Section, SettingRow } from "../../components/ui";
import { IconActionRow } from "./rows";
import { settingsStyles as s } from "./styles";
import type { EditTarget } from "./types";

/**
 * 链路与电脑端状态。
 *
 * 这一块原本叫「组网」,大半是 ZeroTier 的东西:网络 ID、节点授权、自愈状态、
 * 本机节点 ID……链路收敛到公网隧道之后,那些全都没有意义了。
 *
 * 留下的两样是真正用得上的:
 * - **电脑地址**:手机在连哪个入口。出问题时第一眼看的就是它。
 * - **后端状态**:链路另一端到底活着没有。隧道通了不代表后端在跑,
 *   而这两件事在手机上的表现都是"连不上",分开看才排得动。
 */
export function LinkSection({
  config,
  health,
  notice,
  onEdit,
  onSaveUrl,
  onRefreshHealth,
}: {
  config: StoredConfig;
  health: HealthResponse | null;
  notice: string | null;
  onEdit: (target: EditTarget) => void;
  onSaveUrl: (url: string) => Promise<void>;
  onRefreshHealth: () => Promise<void>;
}) {
  const dot = (ok: boolean | undefined) => (ok ? theme.color.ok : theme.color.danger);

  /**
   * 救援模式:这个 health 不是后端答的,是电脑上那个独立的救援进程答的
   * (`server/src/rescue.ts`)—— 也就是**后端进程本身没在跑**。
   *
   * ⚠️ 这时候下面有两行必须**藏起来**:它们的值在救援模式下没有意义
   * (`uptimeSec` 是救援进程自己的,`sessions` 恒为 0)。让它们显示出来比不显示更糟 ——
   * 使用者会把"跑了 3 秒"当成后端,把那个 0 读成"机器上真没有会话"。
   */
  const rescue = health?.rescue ?? null;

  return (
    <Section title="电脑连接">
      <View style={s.group}>
        {rescue ? (
          <View style={styles.rescue}>
            <Text style={styles.rescueTitle}>电脑连接服务未运行</Text>
            <Text style={styles.rescueBody}>{rescue.reason}</Text>
            {rescue.bootLogTail ? (
              <Text style={styles.rescueLog} numberOfLines={6}>
                {rescue.bootLogTail}
              </Text>
            ) : null}
            <Text style={styles.rescueHint}>
              可在「故障排查」中重启服务。
            </Text>
          </View>
        ) : null}
        {/*
          地址必须可改。曾经把它设成只读(理由是"改地址会弄坏 token"),那个判断是错的:
          token 绑的是后端而不是地址。而只读的代价很实在 —— 换服务器、换端口、或者
          地址填错了,用户就只能靠"解除配对"再重配一遍才能改。留个输入口便宜得多。
        */}
        <CopyRow
          label="电脑地址"
          value={config.serverUrl ?? "未设置"}
          mono={false}
          onEdit={() =>
            onEdit({
              title: "电脑地址",
              value: config.serverUrl ?? "",
              placeholder: "https://你的服务器:端口",
              hint: "输入配对时使用的电脑地址",
              save: onSaveUrl,
            })
          }
        />
        <SettingRow title="服务版本" right={<Text style={s.value}>{health?.version ?? "暂不可用"}</Text>} />
        <SettingRow
          title="账户服务"
          right={
            <Text style={[s.value, { color: dot(health?.upstream.ccSwitch) }]}>
              {health?.upstream.ccSwitch ? "运行中" : "未连接（可选）"}
            </Text>
          }
        />
        <SettingRow
          title="网络代理"
          right={
            <Text style={[s.value, { color: dot(health?.upstream.mihomo) }]}>
              {health?.upstream.mihomo ? "运行中" : "未连接（可选）"}
            </Text>
          }
        />
        <IconActionRow
          title="重新检测"
          subtitle="检查电脑连接状态"
          icon="refresh"
          iconLabel="重新检测"
          onPress={() => void onRefreshHealth()}
        />
        {notice ? <Text style={s.notice}>{notice}</Text> : null}
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  /**
   * 救援模式那条横幅。
   *
   * 用 warn(琥珀)而不是 danger(红):后端没在跑**不是数据损坏**,而且这条横幅
   * 下面就有个能直接把它拉起来的按钮 —— 红字会让人以为出了不可挽回的事,
   * 而实际上他只要点一下。
   */
  rescue: {
    marginVertical: theme.space(2),
    borderWidth: 1,
    borderColor: theme.color.warn,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.color.warnSoft,
    padding: theme.space(3),
    gap: theme.space(1),
  },
  rescueTitle: {
    color: theme.color.warn,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.bold,
  },
  rescueBody: { color: theme.color.text, fontSize: theme.font.size.sm, lineHeight: 19 },
  /** boot.log 那几行 —— 用等宽,因为它本来就是日志,缩进和对齐有意义 */
  rescueLog: {
    color: theme.color.textDim,
    fontSize: theme.font.size.xs,
    lineHeight: 16,
    fontFamily: theme.font.mono,
  },
  rescueHint: { color: theme.color.textFaint, fontSize: theme.font.size.xs, lineHeight: 17 },
});
