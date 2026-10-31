import { useState } from "react";
import { Alert, Text, View } from "react-native";
import type { Api } from "../../api";
import { Section } from "../../components/ui";
import { downloadUrlAndOpen } from "../../download";
import { errText } from "../../util";
import { IconActionRow } from "./rows";
import { settingsStyles as s } from "./styles";

/**
 * 故障排查 —— 后端出问题时手机能做的两件事。
 *
 * ## 为什么单独一节,而不是塞进「链路」里
 *
 * 「链路」那一节全是**状态**(后端版本、上游在不在、跑了多久),人扫一眼就该走;
 * 这一节全是**动作**,而且其中一个会把手上的会话流掐断。混在一起的话,"顺手点一下"
 * 的门槛就太低了。
 *
 * ## 这两个动作补的是同一个缺口
 *
 * 工作场景是**人不在电脑前**。以前后端一出问题,手机这侧只有一条"连不上" ——
 * 既看不到原因(日志在电脑上),也做不了动作(重启要人到电脑前按)。
 * 导出诊断把日志带到手机上,重启则让别人不用回去。
 *
 * ⚠️ 这两个都只在**后端还活着**时可用。后端进程整个不在了的话,手机连的就是一条
 * 死隧道 —— 那种情况要靠救援通道(见 `server/src/rescue.ts`)。
 */
export function RecoverySection({ api }: { api: Api }) {
  const [busy, setBusy] = useState<null | "diag" | "restart">(null);
  const [notice, setNotice] = useState<string | null>(null);

  const exportDiagnostics = async () => {
    setBusy("diag");
    setNotice(null);
    try {
      const out = await downloadUrlAndOpen(api.recoveryDiagnosticsUrl(), "remotecc-diagnostics.txt");
      setNotice(
        out.ok
          ? `已导出 ${out.name} —— 里面是电脑上那几份日志的尾部(已脱敏)`
          : out.cancelled
            ? out.message
            : `导出失败:${out.message}`,
      );
    } catch (err) {
      setNotice(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const doRestart = async () => {
    setBusy("restart");
    setNotice(null);
    try {
      const out = await api.restartBackend();
      // ⚠️ 文案必须照实说"排定了",不能说"已重启" —— 后端还要等一会儿才动手。
      // 说成"已重启"的话,几秒后那条流断掉时会让人以为又坏了。
      setNotice(`已排定:${out.delaySec} 秒后重启连接服务。手机上这条流会断,重启完重新进一次会话。`);
    } catch (err) {
      setNotice(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const confirmRestart = () => {
    Alert.alert(
      "重启连接服务",
      "手机连接会短暂断开，稍后将自动重新连接。\n\n" +
        "是否现在重启连接服务？",
      [
        { text: "取消", style: "cancel" },
        { text: "重启", style: "destructive", onPress: () => void doRestart() },
      ],
    );
  };

  return (
    <Section title="故障排查">
      <View style={s.group}>
        <IconActionRow
          title="导出诊断"
          subtitle="保存已脱敏的诊断信息"
          icon="document-text-outline"
          iconLabel="导出诊断"
          onPress={() => void exportDiagnostics()}
          loading={busy === "diag"}
        />
        <IconActionRow
          title="重启连接服务"
          subtitle="连接异常时，可远程重启连接服务"
          icon="power-outline"
          iconLabel="重启连接服务"
          onPress={confirmRestart}
          loading={busy === "restart"}
        />
        {notice ? <Text style={s.notice}>{notice}</Text> : null}
      </View>
    </Section>
  );
}
