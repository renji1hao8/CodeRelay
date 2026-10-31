import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Section, SettingRow } from "../../components/ui";
import { chooseDownloadDir, getDownloadDir } from "../../download";
import { settingsStyles as s } from "./styles";
import { IconActionRow } from "./rows";

/**
 * SAF 的 uri 又长又难读(`content://com.android.externalstorage.documents/tree/primary%3ADownload`),
 * 取最后一段解码出来给人看。
 */
function friendly(uri: string): string {
  const tail = uri.split("/").filter(Boolean).pop() ?? uri;
  try {
    return decodeURIComponent(tail).replace(/^primary:/, "内部存储/");
  } catch {
    return tail;
  }
}

/**
 * 下载位置。
 *
 * ⚠️ 为什么需要它能改:下载落到哪里以前是写死的 **App 私有缓存**
 * (`/data/user/0/<包名>/cache/`)—— 文件管理器扫不到、没 root 也进不去,
 * 而且系统随时会清掉它。使用者的原话是「我能下载,但是文件管理中找不到在哪」。
 *
 * 现在走 SAF,让他自己指一个目录(选一次就记住)。这块就是用来**改那个目录**的 ——
 * 没有它,选错了就只剩"清除 App 数据"一条路。
 */
export function DownloadSection() {
  const [dir, setDir] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getDownloadDir().then(setDir);
  }, []);

  const change = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const ok = await chooseDownloadDir();
      if (!ok) {
        setNotice("没有选择,保持原来的位置");
        return;
      }
      setDir(await getDownloadDir());
      setNotice("下载位置已更新");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="下载">
      <View style={s.group}>
        <SettingRow
          title="保存到"
          subtitle={dir ? friendly(dir) : "还没设置 —— 下次下载时会让你选一个"}
        />
        <IconActionRow
          title="换个位置"
          subtitle="重新挑一个文件夹作为默认下载目录"
          icon="folder-open-outline"
          iconLabel="换位置"
          onPress={() => void change()}
          loading={busy}
        />
        {notice ? <Text style={s.notice}>{notice}</Text> : null}
      </View>
    </Section>
  );
}
