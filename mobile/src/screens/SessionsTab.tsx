import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Api } from "../api";
import type { DesktopProvider, DesktopSession } from "../shared";
import type { LiveChat } from "../../App";
import { theme } from "../theme";
import { DesktopSessionsScreen } from "./DesktopSessionsScreen";
import { DesktopChatScreen } from "./DesktopChatScreen";
let lastSource: DesktopProvider = "claude";
export function SessionsTab({ api, reloadToken = 0, pendingCodexThreadId, pendingClaudeSessionId, onPendingCodexConsumed }: {
  api: Api; onOpenLive: (chat: LiveChat) => void; reloadToken?: number;
  pendingCodexThreadId?: string | null; pendingClaudeSessionId?: string | null; onPendingCodexConsumed?: () => void;
}) {
  const [source, setSource] = useState(lastSource);
  const [visited, setVisited] = useState({ claude: lastSource === "claude", codex: lastSource === "codex" });
  const [desktop, setDesktop] = useState<DesktopSession | null>(null);
  const pick = (next: DesktopProvider) => { lastSource = next; setSource(next); setVisited(old => ({ ...old, [next]: true })); };
  useEffect(() => {
    const id = pendingCodexThreadId || pendingClaudeSessionId;
    if (!id) return;
    const provider = pendingCodexThreadId ? "codex" : "claude";
    pick(provider);
    setDesktop({ id, provider, title: provider === "codex" ? "Codex 会话" : "Claude 会话", cwd: null, updatedAt: null, status: "unknown", canSend: false });
    onPendingCodexConsumed?.();
  }, [pendingCodexThreadId, pendingClaudeSessionId, onPendingCodexConsumed]);
  return <View style={styles.root}>
    {!desktop ? <View style={styles.switchRow}>{(["claude", "codex"] as const).map(provider => <Pressable key={provider} accessibilityRole="tab" accessibilityState={{ selected: source === provider }} onPress={() => pick(provider)} style={[styles.chip, source === provider && styles.selected]}><Text style={[styles.label, source === provider && styles.selectedLabel]}>{provider === "claude" ? "Claude" : "Codex"}</Text></Pressable>)}</View> : null}
    {desktop ? <DesktopChatScreen key={desktop.provider + ":" + desktop.id} api={api} initial={desktop} onBack={() => setDesktop(null)} /> : null}
    {(["claude", "codex"] as const).map(provider => visited[provider] ? <View key={provider} style={{ flex: 1, display: !desktop && source === provider ? "flex" : "none" }}><DesktopSessionsScreen api={api} provider={provider} active={!desktop && source === provider} reloadToken={reloadToken} onOpen={setDesktop} /></View> : null)}
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  switchRow: { flexDirection: "row", gap: theme.space(1), marginHorizontal: theme.gutter, marginTop: theme.space(2), marginBottom: theme.space(1), padding: theme.space(1), borderRadius: theme.radius.md, backgroundColor: theme.color.surface },
  chip: { flex: 1, paddingVertical: theme.space(2), alignItems: "center", borderRadius: theme.radius.sm },
  selected: { backgroundColor: theme.color.surfacePress }, label: { color: theme.color.textDim, fontSize: theme.font.size.sm, fontWeight: "600" }, selectedLabel: { color: theme.color.accent },
});
