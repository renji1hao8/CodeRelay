import { useCallback, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import type { Api } from "../api";
import type { TerminalServerFrame } from "../shared";
import { Header, IconButton } from "../components/ui";
import { useTerminal } from "../shell/useTerminal";
import { terminalHtml } from "../generated/terminal-html";
import { theme } from "../theme";

export function ShellScreen({ api }: { api: Api }) {
  const view = useRef<WebView<object>>(null), [ctrl, setCtrl] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const post = useCallback((frame: unknown) => view.current?.postMessage(JSON.stringify(frame)), []);
  const render = useCallback((frame: TerminalServerFrame) => post(frame), [post]);
  const terminal = useTerminal(api, render);
  const focus = () => { view.current?.requestFocus(); post({ t: "focus" }); };
  const onMessage = (event: WebViewMessageEvent) => {
    let frame: any; try { frame = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (frame.t === "ready") terminal.ready(frame.cols, frame.rows);
    else if (frame.t === "resize") terminal.resize(frame.cols, frame.rows);
    else if (frame.t === "input" && typeof frame.data === "string") terminal.input(frame.data);
    else if (frame.t === "controlUsed") setCtrl(false);
    else if (frame.t === "selection" && typeof frame.text === "string") void Clipboard.setStringAsync(frame.text);
  };
  const key = (data: string) => { terminal.input(data); focus(); };
  const restart = () => Alert.alert("新建终端", "将关闭当前终端，未结束的命令会被终止。", [{ text: "取消", style: "cancel" }, { text: "新建", onPress: terminal.restart }]);
  return <View style={styles.page}>
    <Header title="终端" subtitle={terminal.connected ? terminal.running ? "PowerShell · 已连接" : "PowerShell · 已退出" : "正在连接…"} right={<View style={styles.right}><IconButton icon="copy-outline" label="复制选中内容" onPress={() => post({ t: "copy" })} /><IconButton icon="add" label="新建终端" onPress={restart} /></View>} />
    {terminal.error ? <Text style={styles.error}>{terminal.error}</Text> : null}
    {viewError ? <Text style={styles.error}>{viewError}</Text> : null}
    {terminal.connected && !terminal.running ? <Pressable onPress={terminal.restart}><Text style={styles.notice}>终端已退出{terminal.exitCode !== null ? "（" + terminal.exitCode + "）" : ""} · 点击新建</Text></Pressable> : null}
    <WebView<object> ref={view} style={styles.terminal} source={{ html: terminalHtml }} originWhitelist={["*"]} onMessage={onMessage} onShouldStartLoadWithRequest={request => request.url === "about:blank"} javaScriptEnabled domStorageEnabled={false} allowFileAccess={false} allowUniversalAccessFromFileURLs={false} mixedContentMode="never" setSupportMultipleWindows={false} textZoom={100} overScrollMode="never" androidLayerType="hardware" keyboardDisplayRequiresUserAction={false} automaticallyAdjustContentInsets={false} onError={() => setViewError("终端界面加载失败，请重新打开此页")} />
    <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} style={styles.keysScroll} contentContainerStyle={styles.keys}>
      <Key label="Ctrl" active={ctrl} onPress={() => { const value = !ctrl; setCtrl(value); post({ t: "control", value }); focus(); }} />
      <Key label="Ctrl+C" onPress={() => key("\x03")} /><Key label="Esc" onPress={() => key("\x1b")} /><Key label="Tab" onPress={() => key("\t")} />
      <Key label="↑" onPress={() => key("\x1b[A")} /><Key label="↓" onPress={() => key("\x1b[B")} /><Key label="←" onPress={() => key("\x1b[D")} /><Key label="→" onPress={() => key("\x1b[C")} />
      <Key label="粘贴" onPress={() => { void Clipboard.getStringAsync().then(text => { post({ t: "paste", text }); focus(); }); }} />
      <Key label="键盘" onPress={focus} />
    </ScrollView>
  </View>;
}
function Key({ label, onPress, active }: { label: string; onPress: () => void; active?: boolean }) { return <Pressable accessibilityRole="button" onPress={onPress} style={[styles.key, active && styles.keyOn]}><Text style={styles.keyText}>{label}</Text></Pressable>; }
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.color.bg }, right: { flexDirection: "row" }, terminal: { flex: 1, backgroundColor: theme.color.codeBg },
  error: { color: theme.color.danger, padding: theme.space(3), fontSize: theme.font.size.sm }, notice: { color: theme.color.textDim, padding: theme.space(3), fontSize: theme.font.size.sm },
  keysScroll: { flexGrow: 0, maxHeight: 48, backgroundColor: theme.color.surface }, keys: { gap: theme.space(2), padding: theme.space(2) }, key: { minWidth: 38, height: 32, paddingHorizontal: theme.space(3), borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceAlt, justifyContent: "center", alignItems: "center" }, keyOn: { backgroundColor: theme.color.accentSoft }, keyText: { color: theme.color.text, fontSize: theme.font.size.sm, fontFamily: theme.font.mono },
});
