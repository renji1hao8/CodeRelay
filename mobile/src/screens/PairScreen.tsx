import { useState } from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Api } from "../api";
import { saveDeviceName, saveServer } from "../storage";
import { theme } from "../theme";
import { errText } from "../util";
import { Btn, Card, Row } from "../components/ui";

/**
 * 配对页。
 *
 * 链路只有一条:公网隧道入口。所以这里比早先简单很多 —— 没有连接方式可选、
 * 没有 ZeroTier 网络 ID、也不用等组网就绪。填地址、填配对码、配对。
 *
 * 那个地址由电脑上的 `node scripts/show-pair-info.mjs` 打印出来。
 */
export function PairScreen({
  initialServer,
  deviceName,
  onSaved,
  onPaired,
}: {
  initialServer: string;
  deviceName: string;
  onSaved: (patch: { serverUrl?: string; token?: string; deviceName?: string }) => void;
  onPaired: (token: string) => Promise<void>;
}) {
  const [server, setServer] = useState(initialServer);
  const [name, setName] = useState(deviceName);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const [probeOk, setProbeOk] = useState(false);
  // 两个动作各有各的忙碌标志 —— 共用一个的话,点一下两个按钮会同时转圈,看起来像整个界面卡死
  const [probeBusy, setProbeBusy] = useState(false);
  const [pairBusy, setPairBusy] = useState(false);

  const normalized = server.trim().replace(/\/+$/, "");

  const testConnection = async () => {
    setProbe(null);
    setProbeBusy(true);
    try {
      const health = await new Api({ baseUrl: normalized, token: null }).health();
      setProbeOk(true);
      setProbe(`连接正常 · 服务版本 ${health.version}`);
    } catch (err) {
      setProbeOk(false);
      setProbe(errText(err));
    } finally {
      setProbeBusy(false);
    }
  };

  const pair = async () => {
    setStatus(null);
    setPairBusy(true);
    try {
      const api = new Api({ baseUrl: normalized, token: null });
      const result = await api.claim(code.trim(), name.trim() || "我的手机");
      await saveServer(normalized);
      await saveDeviceName(name.trim() || "我的手机");
      await onPaired(result.token);
      onSaved({
        serverUrl: normalized,
        token: result.token,
        deviceName: name.trim() || "我的手机",
      });
    } catch (err) {
      setStatus(errText(err));
    } finally {
      setPairBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <View style={styles.logo}>
            <Ionicons name="terminal" size={26} color={theme.color.accent} />
          </View>
          <Text style={styles.title}>RemoteCC</Text>
          <Text style={styles.subtitle}>在手机上继续电脑里的 Claude 和 Codex 会话</Text>
        </View>

        <Card>
          <Text style={styles.label}>电脑地址</Text>
          <TextInput
            style={styles.input}
            value={server}
            onChangeText={setServer}
            placeholder="https://你的服务器:端口"
            placeholderTextColor={theme.color.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={styles.hint}>
            公网隧道的入口地址。在电脑上运行{" "}
            <Text style={styles.code}>node scripts/show-pair-info.mjs</Text> 会直接把它打印出来。
          </Text>
          <View style={{ marginTop: theme.space(3) }}>
            <Btn label="测试连通" icon="pulse-outline" full onPress={testConnection} loading={probeBusy} />
          </View>
          {probe ? (
            <View style={[styles.probeBox, probeOk && styles.probeBoxOk]}>
              <Ionicons
                name={probeOk ? "checkmark-circle" : "close-circle"}
                size={14}
                color={probeOk ? theme.color.ok : theme.color.danger}
              />
              <Text style={[styles.probeText, probeOk && { color: theme.color.ok }]}>{probe}</Text>
            </View>
          ) : null}
        </Card>

        <Card>
          <Text style={styles.label}>配对码</Text>
          <TextInput
            style={[styles.input, styles.codeInput]}
            value={code}
            onChangeText={setCode}
            placeholder="6 位数字"
            placeholderTextColor={theme.color.textFaint}
            keyboardType="number-pad"
            maxLength={6}
          />
          <Text style={styles.hint}>在电脑上运行配对脚本会显示一个 6 位数字,5 分钟内有效。</Text>

          <Text style={[styles.label, { marginTop: theme.space(4) }]}>这台手机的名字</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="例如:我的手机"
            placeholderTextColor={theme.color.textFaint}
          />

          <View style={{ marginTop: theme.space(4) }}>
            <Btn
              label="配对并保存"
              icon="link-outline"
              kind="primary"
              full
              onPress={pair}
              loading={pairBusy}
              disabled={!normalized || code.trim().length !== 6}
            />
          </View>
          {status ? <Text style={styles.statusText}>{status}</Text> : null}
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  content: { padding: theme.gutter, paddingTop: theme.space(14), paddingBottom: theme.space(10) },

  hero: { alignItems: "center", marginBottom: theme.space(8) },
  logo: {
    width: 56,
    height: 56,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.color.accentSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.space(4),
  },
  title: { color: theme.color.text, fontSize: theme.font.size.xxl, fontWeight: theme.font.weight.bold },
  subtitle: { color: theme.color.textDim, fontSize: theme.font.size.sm, marginTop: theme.space(2) },

  label: {
    color: theme.color.textDim,
    fontSize: theme.font.size.xs,
    fontWeight: theme.font.weight.bold,
    marginBottom: theme.space(2),
  },
  input: {
    backgroundColor: theme.color.codeBg,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    color: theme.color.text,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(3),
    fontSize: theme.font.size.md,
  },
  codeInput: {
    fontFamily: theme.font.mono,
    fontSize: 22,
    letterSpacing: 6,
    textAlign: "center",
    paddingVertical: theme.space(4),
  },
  hint: { color: theme.color.textFaint, fontSize: theme.font.size.xs, marginTop: theme.space(2), lineHeight: 17 },

  modeRow: { flexDirection: "row", gap: theme.space(2), marginBottom: theme.space(2) },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
  },
  chipActive: { backgroundColor: theme.color.accent, borderColor: theme.color.accent },
  chipText: { color: theme.color.textDim, fontSize: theme.font.size.sm },
  chipTextActive: { color: theme.color.onAccent, fontWeight: theme.font.weight.semibold },

  code: { fontFamily: theme.font.mono, color: theme.color.textDim },

  probeBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.space(2),
    marginTop: theme.space(3),
    padding: theme.space(3),
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.dangerSoft,
  },
  probeBoxOk: { backgroundColor: theme.color.okSoft },
  probeText: { color: theme.color.danger, fontSize: theme.font.size.sm, flex: 1, lineHeight: 19 },

  statusText: { color: theme.color.warn, fontSize: theme.font.size.sm, marginTop: theme.space(3), lineHeight: 19 },
  error: { color: theme.color.danger, fontSize: theme.font.size.sm, marginTop: theme.space(3), lineHeight: 19 },

  authBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.space(2),
    marginTop: theme.space(3),
    padding: theme.space(3),
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.warnSoft,
  },
  authText: { color: theme.color.warn, fontSize: theme.font.size.sm, flex: 1, lineHeight: 19 },
  authBold: { fontWeight: theme.font.weight.bold },
});
