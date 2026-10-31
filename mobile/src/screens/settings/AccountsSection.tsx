import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Api } from "../../api";
import type { AccountsResponse } from "../../shared";
import { Section, SettingRow } from "../../components/ui";
import { IconActionRow } from "./rows";
import { peek, put } from "../../cache";
import { theme } from "../../theme";
import { errText } from "../../util";

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
function resetHint(value: string | null | undefined, now: number) {
  if (!value) return "";
  const minutes = Math.ceil((Date.parse(value) - now) / 60000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes <= 0) return "已到重置时间，刷新确认";
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后重置`;
}
export function AccountsSection({ api }: { api: Api }) {
  const key = api.cacheKey("accounts");
  const [data, setData] = useState<AccountsResponse | null>(() => peek(key));
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try { const next = await api.accounts(refresh); setData(next); put(key, next); setError(null); }
    catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }, [api, key]);
  useEffect(() => {
    const cached = peek<AccountsResponse>(key);
    if (!cached || Date.now() - Date.parse(cached.fetchedAt) > 60000) void load();
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [load, key]);
  return <>
    <Section title="余额与套餐额度" hint={data ? `${data.providers.length} 个当前供应商` : "电脑账户配置"}>
      <IconActionRow title="刷新余额与额度" subtitle="更新当前账户余额与套餐剩余额度" icon="refresh-outline" iconLabel="刷新" onPress={() => void load(true)} loading={busy} />
      {error ? <Text style={styles.error}>{error}{data ? "；以下保留上次快照" : ""}</Text> : null}
      {data?.providers.map(provider => <View key={`${provider.app}:${provider.id}`} style={styles.card}>
        <Text style={styles.name}>{provider.name}</Text><Text style={styles.meta}>{provider.app} · 当前供应商</Text>
        {provider.error ? <Text style={styles.error}>{provider.error}{provider.rows.length ? "（显示上次成功快照）" : ""}</Text> : null}
        {provider.rows.map((row, i) => <View key={i} style={styles.quota}>
          <View style={styles.row}><Text style={styles.label}>{row.label}</Text><Text style={[styles.value, row.remainingPercent !== undefined && row.remainingPercent < 10 && styles.danger]}>
            {row.remainingPercent !== undefined ? `剩余 ${row.remainingPercent.toFixed(1)}%` : row.remaining !== undefined ? `${row.remaining.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${row.unit ?? ""}` : "额度未提供"}
          </Text></View>
          {row.remainingPercent !== undefined ? <View style={styles.track}><View style={[styles.fill, { width: `${Math.min(100, Math.max(0, row.remainingPercent))}%`, backgroundColor: row.remainingPercent < 10 ? theme.color.danger : row.remainingPercent < 25 ? theme.color.warn : theme.color.accent }]} /></View> : null}
          {row.used !== undefined && row.total !== undefined && row.unit !== "%" ? <Text style={styles.meta}>已用 {row.used.toLocaleString()} / {row.total.toLocaleString()} {row.unit}</Text> : null}
          {resetHint(row.resetsAt, now) ? <Text style={styles.meta}>{resetHint(row.resetsAt, now)}</Text> : null}
        </View>)}
        <Text style={styles.meta}>{provider.fetchedAt ? `${provider.stale ? "旧快照 · " : ""}${new Date(provider.fetchedAt).toLocaleString()}` : "尚无成功查询"}</Text>
      </View>)}
      {!data && busy ? <Text style={styles.meta}>正在查询当前供应商…</Text> : null}
    </Section>
    <Section title="cc-switch 消费记录" hint={data?.spending.available ? `今日 ${money(data.spending.todayUsd)}` : "按电脑记录汇总"}>
      {data?.spending.available ? <>
        <SettingRow title="今日记录费用" right={<Text style={styles.value}>{money(data.spending.todayUsd)}</Text>} />
        <SettingRow title="本月记录费用" right={<Text style={styles.value}>{money(data.spending.monthUsd)}</Text>} />
        <SettingRow title="今日请求 / 用量" right={<Text style={styles.value}>{data.spending.requests} / {data.spending.tokens.toLocaleString()}</Text>} />
        {data.spending.byProvider.map((p, i) => <SettingRow key={i} title={p.name} subtitle={`${p.app} · ${p.requests} 次请求`} right={<Text style={styles.value}>{money(p.costUsd)}</Text>} />)}
        <Text style={styles.meta}>费用来自 cc-switch 记录，可能使用其价格规则估算；供应商实际扣费以余额与账单为准。日期按北京时间。</Text>
      </> : <Text style={styles.meta}>连接 cc-switch 后显示记录；缺少数据时不按零费用显示。</Text>}
    </Section>
  </>;
}
const styles = StyleSheet.create({
  card: { paddingVertical: theme.space(3), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border, gap: theme.space(2) }, name: { color: theme.color.text, fontSize: theme.font.size.md, fontWeight: "600" }, meta: { color: theme.color.textFaint, fontSize: theme.font.size.xs, lineHeight: 19 }, error: { color: theme.color.warn, fontSize: theme.font.size.sm, lineHeight: 20, paddingVertical: theme.space(2) }, quota: { gap: theme.space(2), paddingVertical: theme.space(1) }, row: { flexDirection: "row", justifyContent: "space-between", gap: theme.space(2) }, label: { color: theme.color.textDim, fontSize: theme.font.size.sm, flex: 1 }, value: { color: theme.color.text, fontSize: theme.font.size.sm, fontWeight: "600" }, danger: { color: theme.color.danger }, track: { height: 6, backgroundColor: theme.color.border, borderRadius: 3, overflow: "hidden" }, fill: { height: "100%", borderRadius: 3 },
});
