import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ApiError, type Api } from "../../api";
import { Btn, Section, SettingRow, formatSize } from "../../components/ui";
import { decideUpdate } from "../../appUpdate";
import { downloadUrlAndOpen } from "../../download";
import type { AppReleaseResponse } from "../../shared";
import { theme } from "../../theme";
import { errText } from "../../util";
import { versionCode, versionName } from "../../version";
import { IconActionRow } from "./rows";
import { settingsStyles as s } from "./styles";

/**
 * 关于 / 检查更新。
 *
 * ## 为什么这条值得单独做
 *
 * 这个 App 的工作场景是**人不在电脑前** —— 而它以前的更新方式是
 * `bash scripts/build-android-apk.sh` + `adb install`,两样都要人在电脑前。
 * 于是"随手改一处 App 侧的小毛病"变成一件要挑时间的事。
 *
 * 现在:电脑上编好包(构建脚本会自动把 `versionCode` +1),后端把它当成资源对外发,
 * 手机上点一下就能拿到并交给系统安装器。
 *
 * ## 判据全在 `appUpdate.ts`
 *
 * 这一层只管"问、显示、下",不自己比版本号 —— 那样才有一段能在裸 Node 里跑的用例。
 */
export function AboutSection({ api }: { api: Api }) {
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offer, setOffer] = useState<AppReleaseResponse | null>(null);

  const check = async () => {
    setChecking(true);
    setNotice(null);
    setOffer(null);
    try {
      const decision = decideUpdate(versionCode, await api.appRelease());
      if (decision.kind === "offer") {
        setOffer(decision.release);
      } else if (decision.kind === "latest") {
        setNotice(`已经是最新的(${versionName})`);
      } else {
        setNotice(`无法识别版本信息：${decision.reason}`);
      }
    } catch (err) {
      // ⚠️ **404 不是故障。** 它的意思是"电脑上还没发布过包"(见
      // server/src/routes/app-release.ts)。用红字报"出错了"会让人去查链路,
      // 而实际要做的事是"去电脑上编一个包"。
      if (err instanceof ApiError && err.status === 404) {
        setNotice("暂时没有可用更新");
      } else {
        setNotice(errText(err));
      }
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    if (!offer) return;
    setInstalling(true);
    setProgress(null);
    setNotice(null);
    try {
      const out = await downloadUrlAndOpen(
        api.appApkUrl(),
        `remotecc-${offer.versionName}-${offer.versionCode}.apk`,
        setProgress,
      );
      setNotice(
        out.ok
          ? `已下载 ${out.name} —— 接下来在系统的安装器里点「安装」`
          : out.cancelled
            ? out.message
            : `下载失败:${out.message}`,
      );
    } catch (err) {
      setNotice(errText(err));
    } finally {
      setInstalling(false);
      setProgress(null);
    }
  };

  const percent = progress === null ? null : Math.round(progress * 100);

  return (
    <Section title="关于">
      <View style={s.group}>
        <SettingRow
          title="App 版本"
          subtitle={`内部版本 ${versionCode}`}
          right={<Text style={s.value}>{versionName}</Text>}
        />
        <IconActionRow
          title="检查更新"
          subtitle="查看是否有可用更新"
          icon="cloud-download-outline"
          iconLabel="检查更新"
          onPress={() => void check()}
          loading={checking}
        />

        {offer ? (
          <View style={styles.box}>
            <Text style={styles.title}>
              有新版本 {offer.versionName}(内部版本 {offer.versionCode})
            </Text>
            <Text style={styles.meta}>
              {formatSize(offer.sizeBytes)}
              {offer.notes ? ` · ${offer.notes}` : ""}
            </Text>
            <View style={styles.action}>
              <Btn
                label={installing ? (percent === null ? "下载中…" : `下载中 ${percent}%`) : "下载并安装"}
                kind="primary"
                small
                onPress={() => void install()}
                disabled={installing}
                loading={installing}
              />
            </View>
          </View>
        ) : null}

        {notice ? <Text style={s.notice}>{notice}</Text> : null}
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  box: {
    marginTop: theme.space(3),
    borderWidth: 1,
    borderColor: theme.color.accent,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    gap: theme.space(1),
  },
  title: { color: theme.color.text, fontSize: theme.font.size.md, fontWeight: theme.font.weight.bold },
  meta: { color: theme.color.textDim, fontSize: theme.font.size.sm, lineHeight: 19 },
  action: { flexDirection: "row", marginTop: theme.space(2) },
});
