import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import type { Api } from "../api";
import type { DesktopProvider, DesktopSession, DesktopSessionPage } from "../shared";
import { IconButton, ListSeparator, formatTime } from "../components/ui";
import { peek, put } from "../cache";
import { theme } from "../theme";
import { errText } from "../util";

export function DesktopSessionsScreen({ api, provider, active, reloadToken, onOpen }: {
  api: Api; provider: DesktopProvider; active: boolean; reloadToken: number; onOpen: (session: DesktopSession) => void;
}) {
  const key = api.cacheKey(`desktop-list:${provider}`);
  const [page, setPage] = useState<DesktopSessionPage | null>(() => peek(key));
  const [query, setQuery] = useState(() => peek<string>(key + ":query") ?? "");
  const [collapsed, setCollapsed] = useState<string[]>(() => peek<string[]>(key + ":collapsed") ?? []);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const loading = useRef(false), lastLoaded = useRef(peek<number>(key + ":at") ?? 0);
  const load = useCallback(async (more?: string) => {
    if (loading.current) return;
    loading.current = true; setBusy(true);
    try {
      const next = await api.desktopSessions(provider, more);
      setPage(old => {
        const merged = more && old ? { ...next, sessions: [...new Map([...old.sessions, ...next.sessions].map(s => [s.id, s])).values()] } : next;
        put(key, merged); return merged;
      });
      lastLoaded.current = Date.now(); put(key + ":at", lastLoaded.current); setError(null);
    } catch (e) { setError(errText(e)); } finally { loading.current = false; setBusy(false); }
  }, [api, provider, key]);
  const reload = useRef(reloadToken);
  useEffect(() => {
    const changed = reload.current !== reloadToken; reload.current = reloadToken;
    if (!active) return;
    if (changed || Date.now() - lastLoaded.current > 30000) void load();
    const timer = setInterval(() => void load(), 30000);
    return () => clearInterval(timer);
  }, [active, load, reloadToken]);
  const sections = useMemo(() => {
    const groups = new Map<string, DesktopSession[]>(), q = query.trim().toLowerCase();
    for (const session of page?.sessions ?? []) {
      if (q && !`${session.title} ${session.cwd} ${session.id}`.toLowerCase().includes(q)) continue;
      const cwd = session.cwd ?? "其他会话";
      groups.set(cwd, [...(groups.get(cwd) ?? []), session]);
    }
    return [...groups].map(([title, all]) => ({ title, count: all.length, data: collapsed.includes(title) && !q ? [] : all }));
  }, [page, query, collapsed]);
  return <View style={styles.root}>
    <View style={styles.searchRow}><TextInput style={styles.search} value={query} onChangeText={text => { setQuery(text); put(key + ":query", text); }} placeholder="搜索标题或目录" placeholderTextColor={theme.color.textFaint} />{busy ? <ActivityIndicator size="small" color={theme.color.accent} /> : <IconButton icon="refresh-outline" label="刷新会话" onPress={() => void load()} />}</View>
    {error ? <Text style={styles.error}>{error}{page ? "（保留上次列表）" : ""}</Text> : null}
    {page?.notice ? <Text style={styles.hint}>{page.notice}</Text> : null}
    <SectionList sections={sections} keyExtractor={s => s.id} stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => <Pressable style={styles.group} onPress={() => setCollapsed(old => { const next = old.includes(section.title) ? old.filter(p => p !== section.title) : [...old, section.title]; put(key + ":collapsed", next); return next; })}><Text style={styles.groupTitle} numberOfLines={1}>{collapsed.includes(section.title) ? "▸" : "▾"} {section.title}</Text><Text style={styles.meta}>{section.count}</Text></Pressable>}
      renderItem={({ item }) => <Pressable style={styles.row} onPress={() => onOpen(item)}><View style={styles.rowText}><Text style={styles.title} numberOfLines={1}>{item.title}</Text><Text style={styles.meta}>{item.status === "busy" ? "正在运行" : item.canSend ? "可续接" : "历史记录"}{item.updatedAt ? ` · ${formatTime(item.updatedAt)}` : ""}</Text></View><Text style={styles.meta}>›</Text></Pressable>}
      ItemSeparatorComponent={ListSeparator} contentContainerStyle={styles.content}
      ListEmptyComponent={<Text style={styles.hint}>{busy && !page ? "正在读取桌面会话…" : query ? "没有匹配的会话" : "暂无会话，请先在电脑桌面端打开 Code 会话"}</Text>}
      ListFooterComponent={page?.nextCursor ? <Pressable style={styles.more} onPress={() => void load(page.nextCursor!)} disabled={busy}><Text style={styles.accent}>{busy ? "读取中…" : "加载更多会话"}</Text></Pressable> : undefined} />
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg }, content: { paddingBottom: theme.space(8) }, searchRow: { flexDirection: "row", alignItems: "center", gap: theme.space(2), marginHorizontal: theme.gutter, marginVertical: theme.space(2) }, search: { flex: 1, backgroundColor: theme.color.surfaceAlt, color: theme.color.text, padding: theme.space(3), borderRadius: theme.radius.md, fontSize: theme.font.size.sm },
  group: { flexDirection: "row", alignItems: "center", paddingHorizontal: theme.gutter, paddingTop: theme.space(4), paddingBottom: theme.space(2), gap: theme.space(2) }, groupTitle: { flex: 1, fontSize: theme.font.size.xs, color: theme.color.textDim, fontWeight: "600" }, row: { flexDirection: "row", alignItems: "center", paddingHorizontal: theme.gutter, paddingVertical: theme.space(3), gap: theme.space(3) }, rowText: { flex: 1, gap: theme.space(1) }, title: { color: theme.color.text, fontSize: theme.font.size.md }, meta: { color: theme.color.textFaint, fontSize: theme.font.size.xs }, hint: { color: theme.color.textDim, padding: theme.gutter, fontSize: theme.font.size.sm }, error: { color: theme.color.danger, paddingHorizontal: theme.gutter, paddingVertical: theme.space(2), fontSize: theme.font.size.sm }, more: { alignItems: "center", padding: theme.space(5) }, accent: { color: theme.color.accent },
});
