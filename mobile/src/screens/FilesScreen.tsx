import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { ApiError, type Api } from "../api";
import { peek, put } from "../cache";
import { downloadAndOpen } from "../download";
import type { FsEntry, FsListResponse, FsReadResponse, FsRoot, FsWriteMode } from "../shared";
import { fileKindOf, theme } from "../theme";
import { errText, baseName, withAlpha } from "../util";
import {
  Btn,
  Empty,
  Header,
  IconButton,
  ListRow,
  ListSeparator,
  Sheet,
  SheetInput,
  formatSize,
  formatTime,
} from "../components/ui";

/** 把 "E:\RemoteCC\mobile" 拆成可点击的面包屑 */
function crumbsOf(p: string): { label: string; path: string }[] {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const out: { label: string; path: string }[] = [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}\\${part}` : part;
    out.push({ label: part, path: acc });
  }
  return out;
}

/**
 * 根的显示名。
 *
 * 盘符不显示成 `Z:\` 而显示成 `Z盘` —— 反斜杠和冒号在这里没有信息量,
 * 使用者要认的是"哪个盘"。非盘符的根(比如会话图片目录)退回用目录名。
 */
function rootLabel(p: string): string {
  if (/^[A-Za-z]:\\?$/.test(p)) return `${p[0]!.toUpperCase()}盘`;
  return baseName(p.replace(/[\\/]+$/, "")) || p;
}

/** 权限的显示文案。判定在后端,这里只是把它的结论说清楚 */
const MODE_LABEL: Record<FsWriteMode, string> = {
  readonly: "只读",
  append: "只能添加",
  full: "可读写",
};

/** 缓存"上次在哪个目录、看到了什么"。切 tab 回来时不用重新请求,也不会被弹回根目录 */
interface FsCache {
  cwd: string;
  listing: FsListResponse;
}
const FS_CACHE_KEY = "fs";

export function FilesScreen({
  api,
  reloadToken = 0,
}: {
  api: Api;
  /** 链路从"不通"恢复时由 App 递增,用来把之前失败的那次请求重做一遍 */
  reloadToken?: number;
}) {
  const [cwd, setCwd] = useState<string | null>(() => peek<FsCache>(FS_CACHE_KEY)?.cwd ?? null);
  const [listing, setListing] = useState<FsListResponse | null>(
    () => peek<FsCache>(FS_CACHE_KEY)?.listing ?? null,
  );
  /**
   * 可浏览的位置(盘符 + 会话图片目录)。
   *
   * 以前这里没有它 —— 页面启动就直奔第一个存在的根,而根的 parent 是 null,
   * 于是**根本没地方切盘**,一直被关在 C 盘里。顺带也让 Z盘 这类网络位置无处可去。
   */
  const [roots, setRoots] = useState<FsRoot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [preview, setPreview] = useState<FsReadResponse | null>(null);
  const [menuFor, setMenuFor] = useState<FsEntry | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [makingDir, setMakingDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [uploading, setUploading] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 非 null 时显示下载进度(形如「下载中 42%」) */
  const [downloading, setDownloading] = useState<string | null>(null);

  /**
   * 下载 = 在 **App 内**下,落到使用者自己选的目录里(SAF),再交给系统打开
   * (APK → 安装器,PDF → 阅读器…)。
   *
   * ⚠️ 不能像以前那样 `Linking.openURL(下载地址)` 交给浏览器:服务器用的是自签证书,
   * 那张证书只有 App 认(被钉成了信任锚),**浏览器会拦成「不是私密连接,攻击者可能
   * 试图窃取…」** —— 于是预览能看,下载却永远打不开。详见 src/download.ts。
   *
   * ⚠️ 也不再下到 App 私有缓存了 —— 那里文件管理器根本看不到。第一次会弹出系统
   * 目录选择器(问一次,之后记住),所以这里没有加载中的措辞要照顾"选目录"那一段。
   */
  const startDownload = useCallback(
    (path: string) => {
      if (downloading) return;
      setError(null);
      setNotice(null);
      setDownloading("准备下载…");
      void downloadAndOpen(api, path, (ratio) => {
        setDownloading(ratio === null ? "下载中…" : `下载中 ${Math.round(ratio * 100)}%`);
      }).then((res) => {
        setDownloading(null);
        if (res.ok) {
          setNotice(`已存到 ${res.name},并交给系统打开`);
          return;
        }
        // 在目录选择器上点了取消不是错误 —— 弹红字只会让人以为自己弄坏了什么
        if (!res.cancelled) setError(`下载失败:${res.message}`);
      });
    },
    [api, downloading],
  );

  const browse = useCallback(
    async (path: string, silent = false) => {
      if (!silent) setBusy(true);
      setError(null);
      try {
        const result = await api.fsList(path);
        setListing(result);
        setCwd(result.path);
        put(FS_CACHE_KEY, { cwd: result.path, listing: result } satisfies FsCache);
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusy(false);
        setRefreshing(false);
      }
    },
    [api],
  );

  const loadRoots = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // ⚠️ 同样不许把 undefined 当数组用:响应形状不对就退回空(下面那句 list.length 会崩)
      const { roots } = await api.fsRoots();
      const list = Array.isArray(roots) ? roots : [];
      setRoots(list);
      if (list.length === 0) setError("电脑上还没有配置任何可访问的位置");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
      setRefreshing(false);
    }
  }, [api]);

  /** 回到位置列表。根目录的 parent 是 null,所以这是唯一的"再上一层" */
  const showRoots = () => {
    setListing(null);
    setCwd(null);
    setError(null);
    void loadRoots();
  };

  // 恢复后重拉时,要留在用户当前所在的目录,而不是把他弹回根目录
  const cwdRef = useRef<string | null>(null);
  cwdRef.current = cwd;

  useEffect(() => {
    void (async () => {
      const current = cwdRef.current;
      if (current) {
        await browse(current, true);
        return;
      }
      await loadRoots();
    })();
  }, [api, browse, loadRoots, reloadToken]);

  const openFile = async (entry: FsEntry) => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.fsRead(entry.path));
    } catch (err) {
      /**
       * ⚠️ 后端对超过 5MB 的文件回 413,而这里原来只把它变成一句红字。
       *
       * 经反向代理访问时，在文件目录中点了一个
       * APK,连点几次都是红字 —— 那正是"文件界面一直在出错"的样子。可 413 根本不是
       * "坏了",是"这条预览的路走不通,该改用下载"。让他自己从红字里猜下一步是没道理的。
       */
      if (err instanceof ApiError && err.status === 413) {
        Alert.alert(
          "这个文件太大,预览不了",
          `${baseName(entry.path)}(${formatSize(entry.size)})超过了预览上限。下载下来交给系统应用打开吗?`,
          [
            { text: "取消", style: "cancel" },
            { text: "下载", onPress: () => startDownload(entry.path) },
          ],
        );
        return; // finally 里会把 busy 收掉
      }
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (entry: FsEntry) => {
    setMenuFor(null);
    Alert.alert("确认删除", `将永久删除:\n${entry.path}`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: async () => {
          try {
            const intent = await api.fsDeleteIntent(entry.path);
            await api.fsDelete(entry.path, intent.confirmToken);
            if (cwd) await browse(cwd, true);
          } catch (err) {
            setError(errText(err));
          }
        },
      },
    ]);
  };

  const makeDir = async () => {
    const name = newDirName.trim();
    if (!cwd || !name) return;
    try {
      await api.fsMkdir(`${cwd}\\${name}`);
      setNewDirName("");
      setMakingDir(false);
      await browse(cwd, true);
    } catch (err) {
      setError(errText(err));
    }
  };

  /** 选手机上的文件传到当前目录。一次选多个时逐个传,便于显示进度 */
  const pickAndUpload = async () => {
    if (!cwd) return;
    setActionsOpen(false);
    setError(null);
    setNotice(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
      if (picked.canceled) return;
      const assets = picked.assets ?? [];
      if (assets.length === 0) return;

      const done: string[] = [];
      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        if (!asset) continue;
        const label = `${i + 1}/${assets.length}:${asset.name}`;
        setUploading(`正在上传 ${label}`);
        const result = await api.fsUpload(
          cwd,
          {
            uri: asset.uri,
            name: asset.name,
            mimeType: asset.mimeType ?? "application/octet-stream",
          },
          (sent, total) => {
            const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
            setUploading(`正在上传 ${label}\n${pct}%`);
          },
        );
        done.push(...result.files);
      }
      setNotice(`已上传 ${done.length} 个文件到 ${cwd}`);
      await browse(cwd, true);
    } catch (err) {
      setError(errText(err));
    } finally {
      setUploading(null);
    }
  };

  // ------------------------------------------------------------ 文件预览

  if (preview) {
    const name = baseName(preview.path) || preview.path;
    const kind = fileKindOf(name, false);
    const isImage = preview.mime.startsWith("image/");

    return (
      <View style={styles.root}>
        <Header
          title={name}
          subtitle={formatSize(preview.size)}
          onBack={() => setPreview(null)}
          right={
            <IconButton
              icon="download-outline"
              label="下载到手机"
              onPress={() => startDownload(preview.path)}
            />
          }
        />

        <ScrollView contentContainerStyle={{ padding: theme.space(4), paddingBottom: theme.space(10) }}>
          <View style={styles.metaRow}>
            <View style={[styles.kindDot, { backgroundColor: kind.color }]} />
            <Text style={styles.metaText}>{preview.mime}</Text>
          </View>
          <Text style={styles.pathText} selectable>
            {preview.path}
          </Text>

          {isImage ? (
            <Image
              source={{ uri: api.fileUrl(preview.path, true) }}
              style={styles.image}
              resizeMode="contain"
            />
          ) : (
            <View style={styles.codeBox}>
              <Text style={styles.codeText} selectable>
                {preview.encoding === "base64" ? "(二进制内容,请下载查看)" : preview.text}
              </Text>
            </View>
          )}

          <View style={{ marginTop: theme.space(5), gap: theme.space(2) }}>
            <Btn
              label="下载到手机"
              icon="download-outline"
              kind="primary"
              full
              onPress={() => startDownload(preview.path)}
            />
            <Btn
              label="复制路径"
              icon="link-outline"
              full
              onPress={() => {
                void Clipboard.setStringAsync(preview.path);
                setNotice(`已复制路径:${preview.path}`);
              }}
            />
          </View>
        </ScrollView>
      </View>
    );
  }

  // ------------------------------------------------------------ 位置列表
  //
  // 没有 cwd 时显示它。以前没有这一屏 —— 页面启动就直奔第一个存在的根,
  // 而根的 parent 是 null,于是 C 盘以外的位置(包括 Z盘)根本没有入口。

  if (!cwd) {
    return (
      <View style={styles.root}>
        <Header
          title="文件"
          subtitle={roots ? `${roots.length} 个位置` : undefined}
          right={
            <IconButton
              icon="refresh-outline"
              label="刷新位置列表"
              onPress={() => void loadRoots()}
              color={theme.color.accent}
            />
          }
        />
        {error ? <Banner tone="error" text={error} /> : null}
        {busy && !roots ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.color.accent} />
          </View>
        ) : (
          <FlatList
            data={roots ?? []}
            keyExtractor={(r) => r.path}
            ItemSeparatorComponent={() => <ListSeparator />}
            contentContainerStyle={{ paddingBottom: theme.space(8) }}
            renderItem={({ item }) => (
              <ListRow
                icon={item.writeMode === "readonly" ? "cloud-outline" : "folder-open-outline"}
                iconColor={item.writeMode === "readonly" ? theme.color.accent : theme.color.textDim}
                iconBg={withAlpha(item.writeMode === "readonly" ? theme.color.accent : theme.color.textDim, 0.08)}
                title={rootLabel(item.path)}
                subtitle={!item.exists ? "不可用" : MODE_LABEL[item.writeMode]}
                dim={!item.exists}
                onPress={item.exists ? () => void browse(item.path) : undefined}
                right={
                  item.exists ? (
                    <Ionicons name="chevron-forward" size={16} color={theme.color.textFaint} />
                  ) : null
                }
              />
            )}
          />
        )}
      </View>
    );
  }

  // ------------------------------------------------------------ 主界面

  const crumbs = crumbsOf(cwd);
  const parent = listing?.parent ?? null;
  /**
   * 这个目录允许做什么。**判定在后端**,这里只是据此决定显示哪些入口 ——
   * 藏按钮挡的是误触,真拦截是 assertCanCreate / assertCanDelete。
   */
  const writeMode: FsWriteMode = listing?.writeMode ?? "append";
  const canCreate = writeMode !== "readonly";
  const canDelete = writeMode === "full";

  return (
    <View style={styles.root}>
      <Header
        title={rootLabel(cwd)}
        subtitle={`${listing?.entries.length ?? 0} 项${writeMode === "full" ? "" : ` · ${MODE_LABEL[writeMode]}`}`}
        onBack={parent ? () => void browse(parent) : showRoots}
        backIcon="arrow-up"
        right={
          canCreate ? (
            <IconButton icon="add" onPress={() => setActionsOpen(true)} color={theme.color.accent} size={24} />
          ) : undefined
        }
      />

      {/* 面包屑:直接跳回任意上级 */}
      {crumbs.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.crumbScroll}
          contentContainerStyle={styles.crumbBar}
          keyboardShouldPersistTaps="handled"
        >
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <View key={c.path} style={styles.crumbItem}>
                {i > 0 ? <Ionicons name="chevron-forward" size={12} color={theme.color.textFaint} /> : null}
                <Pressable
                  onPress={() => !last && void browse(c.path)}
                  disabled={last}
                  hitSlop={6}
                  style={({ pressed }) => [
                    styles.crumb,
                    last && { backgroundColor: theme.color.surfaceAlt },
                    pressed && !last && { backgroundColor: theme.color.surfacePress },
                  ]}
                >
                  <Text style={[styles.crumbText, last && { color: theme.color.text }]} numberOfLines={1}>
                    {c.label}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      ) : null}

      {error ? <Banner tone="error" text={error} /> : null}
      {notice ? <Banner tone="ok" text={notice} /> : null}
      {/* 下载进度。44MB 走隧道要几分钟,没这个看起来就像卡死了 */}
      {downloading ? <Banner tone="ok" text={downloading} /> : null}

      {busy && !listing ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.accent} />
        </View>
      ) : !listing ? (
        <Empty text="没有可浏览的目录" icon="folder-open-outline" />
      ) : (
        <FlatList
          data={listing.entries}
          keyExtractor={(item) => item.path}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                if (cwd) void browse(cwd, true);
              }}
              tintColor={theme.color.accent}
              colors={[theme.color.accent]}
              progressBackgroundColor={theme.color.surfaceAlt}
            />
          }
          ItemSeparatorComponent={() => <ListSeparator />}
          contentContainerStyle={{ paddingBottom: theme.space(8) }}
          ListEmptyComponent={<Empty text="这个目录是空的" icon="file-tray-outline" />}
          renderItem={({ item }) => {
            const kind = fileKindOf(item.name, item.kind === "dir");
            return (
              <ListRow
                icon={kind.icon as never}
                iconColor={kind.color}
                iconBg={withAlpha(kind.color, 0.08)}
                title={item.name}
                subtitle={
                  item.kind === "dir" ? "文件夹" : `${formatSize(item.size)} · ${formatTime(item.mtime)}`
                }
                onPress={() => (item.kind === "dir" ? void browse(item.path) : void openFile(item))}
                onLongPress={() => setMenuFor(item)}
                right={
                  item.kind === "dir" ? (
                    <Ionicons name="chevron-forward" size={16} color={theme.color.textFaint} />
                  ) : null
                }
              />
            );
          }}
        />
      )}

      {/* 当前目录下的操作 */}
      <Sheet
        visible={actionsOpen}
        onClose={() => setActionsOpen(false)}
        title={cwd ? `在 ${crumbs.at(-1)?.label ?? cwd} 下` : "当前没有可操作的目录"}
        subtitle={cwd ?? undefined}
      >
        <Btn
          label="上传手机上的文件"
          icon="cloud-upload-outline"
          kind="primary"
          full
          disabled={!cwd}
          onPress={() => void pickAndUpload()}
        />
        <Btn
          label="新建文件夹"
          icon="folder-outline"
          full
          disabled={!cwd}
          onPress={() => {
            setActionsOpen(false);
            setMakingDir(true);
          }}
        />
        <Btn
          label="刷新"
          icon="refresh-outline"
          full
          disabled={!cwd}
          onPress={() => {
            setActionsOpen(false);
            if (cwd) void browse(cwd, true);
          }}
        />
        <Btn
          label="复制当前目录路径"
          icon="link-outline"
          full
          disabled={!cwd}
          onPress={() => {
            setActionsOpen(false);
            if (cwd) {
              void Clipboard.setStringAsync(cwd);
              setNotice(`已复制路径:${cwd}`);
            }
          }}
        />
      </Sheet>

      {/* 单个条目的操作 */}
      <Sheet
        visible={Boolean(menuFor)}
        onClose={() => setMenuFor(null)}
        title={menuFor?.name}
        subtitle={menuFor?.path}
      >
        {menuFor ? (
          <>
            <Btn
              label="下载到手机"
              icon="download-outline"
              kind="primary"
              full
              onPress={() => {
                startDownload(menuFor.path);
                setMenuFor(null);
              }}
            />
            {/* 复制路径 —— 用来在手机对话里贴给 AI 定位这个文件 */}
            <Btn
              label="复制路径"
              icon="link-outline"
              full
              onPress={() => {
                void Clipboard.setStringAsync(menuFor.path);
                setMenuFor(null);
                setNotice(`已复制路径:${menuFor.path}`);
              }}
            />
            {/* 只有 full 才给删除。append / readonly 都不显示 —— 长按在它们里照样能触发这个菜单 */}
            {canDelete ? (
              <Btn label="删除" icon="trash-outline" kind="danger" full onPress={() => remove(menuFor)} />
            ) : null}
            <Btn label="取消" kind="quiet" full onPress={() => setMenuFor(null)} />
          </>
        ) : null}
      </Sheet>

      {/* 新建文件夹 */}
      <Sheet visible={makingDir} onClose={() => setMakingDir(false)} title="新建文件夹" subtitle={cwd ?? undefined}>
        <SheetInput
          value={newDirName}
          onChangeText={setNewDirName}
          placeholder="文件夹名"
          autoFocus
        />
        <Btn
          label="创建"
          kind="primary"
          full
          disabled={!newDirName.trim()}
          onPress={() => void makeDir()}
        />
        <Btn
          label="取消"
          kind="quiet"
          full
          onPress={() => {
            setMakingDir(false);
            setNewDirName("");
          }}
        />
      </Sheet>

      {uploading ? (
        <View style={styles.overlay}>
          <View style={styles.overlayBox}>
            <ActivityIndicator color={theme.color.accent} />
            <Text style={styles.overlayText} numberOfLines={3}>
              {uploading}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** 页顶提示条。错误和成功只差图标与配色,共用一个组件,免得两处各写一遍 */
function Banner({ tone, text }: { tone: "error" | "ok"; text: string }) {
  const ok = tone === "ok";
  return (
    <View style={[styles.banner, ok && styles.bannerOk]}>
      <Ionicons
        name={ok ? "checkmark-circle-outline" : "alert-circle-outline"}
        size={15}
        color={ok ? theme.color.ok : theme.color.danger}
      />
      <Text style={[styles.bannerText, ok && { color: theme.color.ok }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },

  /**
   * ⚠️ 必须显式关掉 flexGrow。
   *
   * RN 的横向 ScrollView 自带 `flexGrow: 1, flexShrink: 1`(见 ScrollView 源码的
   * baseHorizontal),放进 `flex: 1` 的纵向容器里就会撑满剩余高度 —— 面包屑只有一行文字
   * 却吃掉半屏,把底下的列表整个挤到下半部分,看着就像"列表被居中"了。
   *
   * 面包屑只在二级目录及以下才渲染(crumbs.length > 1),所以根目录看起来是正常的。
   */
  crumbScroll: { flexGrow: 0, flexShrink: 0 },
  crumbBar: { paddingHorizontal: theme.space(3), paddingBottom: theme.space(3), gap: 2, alignItems: "center" },
  crumbItem: { flexDirection: "row", alignItems: "center", gap: 2 },
  crumb: { paddingHorizontal: theme.space(2), paddingVertical: 4, borderRadius: theme.radius.xs },
  crumbText: { color: theme.color.textDim, fontSize: theme.font.size.sm },

  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.space(2),
    marginHorizontal: theme.space(4),
    marginBottom: theme.space(2),
    padding: theme.space(3),
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.dangerSoft,
  },
  bannerOk: { backgroundColor: theme.color.okSoft },
  bannerText: { color: theme.color.danger, fontSize: theme.font.size.sm, flex: 1, lineHeight: 18 },


  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  metaRow: { flexDirection: "row", alignItems: "center", gap: theme.space(2), marginBottom: theme.space(2) },
  kindDot: { width: 8, height: 8, borderRadius: 4 },
  metaText: { color: theme.color.textDim, fontSize: theme.font.size.xs },
  pathText: {
    color: theme.color.textFaint,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
    marginBottom: theme.space(4),
  },

  codeBox: {
    backgroundColor: theme.color.codeBg,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    padding: theme.space(3),
  },
  codeText: {
    // 走主题的 codeText,不另找一个冷蓝 —— 暖色体系刻意不收冷色
    color: theme.color.codeText,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.xs,
    lineHeight: 18,
  },
  image: { width: "100%", height: 340, backgroundColor: theme.color.codeBg, borderRadius: theme.radius.md },

  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.color.overlay,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.space(8),
  },
  overlayBox: {
    backgroundColor: theme.color.surfaceAlt,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    padding: theme.space(5),
    alignItems: "center",
    gap: theme.space(3),
    minWidth: 220,
  },
  overlayText: { color: theme.color.text, fontSize: theme.font.size.sm, textAlign: "center" },
});
