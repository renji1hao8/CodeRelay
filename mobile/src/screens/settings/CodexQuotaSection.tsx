import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Api } from "../../api";
import { Section, SettingRow } from "../../components/ui";
import { buildQuotaView, type QuotaView } from "../../codexQuota";
import type { CodexQuotaResponse } from "../../shared";
import { theme } from "../../theme";
import { errText } from "../../util";
import { IconActionRow } from "./rows";
import { settingsStyles as s } from "./styles";

/**
 * Codex(ChatGPT Plus)的额度 —— 还剩多少、什么时候重置。
 *
 * ## 为什么这块在设置页,而不是别处
 *
 * 它和「账单」是同一类东西(都在回答"我还能用多少"),而账单就在这一页 ——
 * 两个"用量"放一起,找的时候不用想。
 *
 * ## ⚠️ 读数**不花额度**
 *
 * 后端走的是 Codex app-server 的一次协议调用(`account/rateLimits/read`),
 * 不是模型请求。所以这里放开手刷新,不必担心"看一眼反而把它花掉了"。
 *
 * ## ⚠️ "没装 Codex CLI"是可预期状态,不是故障
 *
 * 这台机器上没装独立 Codex CLI 时后端回 503 + 一句人话。这时**不要**渲染成红字故障 ——
 * 使用者要做的是"去装一个",而那正是那句话会告诉他的。
 */
export function CodexQuotaSection({ api }: { api: Api }) {
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<QuotaView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const raw = await api.codexQuota();
      setView(buildQuotaView(raw as CodexQuotaResponse, Date.now()));
    } catch (err) {
      // 读失败时**保留上一次的数字**?不 —— 那会让人以为它是新的。
      // 清掉并明说为什么,比留一个可能已经过期的画面诚实。
      setView(null);
      setNotice(errText(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Section title="Codex 额度">
      <View style={s.group}>
        <IconActionRow
          title="刷新"
          subtitle="读一次电脑上 Codex 的额度 —— 这一步不消耗额度"
          icon="refresh"
          iconLabel="刷新"
          onPress={() => void load()}
          loading={loading}
        />

        {notice ? <Text style={s.notice}>{notice}</Text> : null}

        {view ? (
          <>
            {view.blocked ? (
              <View style={styles.blocked}>
                <Text style={styles.blockedTitle}>额度已用尽</Text>
                <Text style={styles.blockedBody}>
                  {view.rows.find((r) => r.resetHint)?.resetHint || "等它自己重置"}
                  {view.resetCredits > 0 ? `\n你手上还有 ${view.resetCredits} 次「重置额度」没用。` : ""}
                </Text>
              </View>
            ) : null}

            {view.rows.length === 0 ? (
              <Text style={s.sectionHint}>没读到任何额度窗口 —— Codex 那边可能还没建过会话。</Text>
            ) : (
              view.rows.map((r) => (
                <View key={r.label} style={styles.row}>
                  <View style={styles.rowHead}>
                    <Text style={styles.label}>{r.label}</Text>
                    <Text style={[styles.percent, r.percent >= 100 && styles.percentFull]}>{r.percent}%</Text>
                  </View>
                  <View style={styles.track}>
                    <View
                      style={[
                        styles.fill,
                        { width: `${r.percent}%` },
                        r.percent >= 100 ? styles.fillFull : r.percent >= 80 ? styles.fillWarn : null,
                      ]}
                    />
                  </View>
                  {r.resetHint ? <Text style={styles.hint}>{r.resetHint}</Text> : null}
                </View>
              ))
            )}

            {view.balance ? (
              <SettingRow title="余额" right={<Text style={s.value}>{view.balance}</Text>} />
            ) : null}
            {view.resetCredits > 0 ? (
              <SettingRow
                title="可用的重置额度"
                subtitle="Codex 允许用它把当前窗口提前重置"
                right={<Text style={s.value}>{view.resetCredits} 次</Text>}
              />
            ) : null}

            <Text style={s.sectionHint}>
              套餐 {view.plan || "取不到"} · 读取于 {view.ageHint || "刚刚"}
            </Text>
          </>
        ) : null}
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  /** 进度条。用「已用」而不是「剩余」—— 与它上面那个百分比同向,不然要反着想 */
  row: { marginTop: theme.space(3), gap: theme.space(1) },
  rowHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  label: { color: theme.color.text, fontSize: theme.font.size.md },
  percent: { color: theme.color.textDim, fontSize: theme.font.size.sm },
  percentFull: { color: theme.color.danger, fontWeight: theme.font.weight.bold },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.color.border,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: 3, backgroundColor: theme.color.accent },
  fillWarn: { backgroundColor: theme.color.warn },
  fillFull: { backgroundColor: theme.color.danger },
  hint: { color: theme.color.textFaint, fontSize: theme.font.size.xs },

  /**
   * 「额度已用尽」那条横幅。
   *
   * 用 danger(红)而不是 warn:这一条**真的挡住你用** —— 与救援模式那条(琥珀)不同,
   * 那个只是"后端没在跑,点一下就好"。这里的行动项(用掉重置额度 / 等重置)是要花钱或花时间的。
   */
  blocked: {
    marginTop: theme.space(3),
    borderWidth: 1,
    borderColor: theme.color.danger,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    gap: theme.space(1),
  },
  blockedTitle: { color: theme.color.danger, fontSize: theme.font.size.md, fontWeight: theme.font.weight.bold },
  blockedBody: { color: theme.color.text, fontSize: theme.font.size.sm, lineHeight: 19 },
});
