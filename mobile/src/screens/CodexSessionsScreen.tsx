import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Api } from "../api";
import { peek, put } from "../cache";
import { makeLocalMessage } from "../messageMerge";
import { ListSeparator, Btn, Empty, Header, IconButton, Sheet, SheetInput, formatTime } from "../components/ui";
import { TreeGutter } from "../components/TreeGutter";
// ⚠️ 分组那一套**与 Claude 那条列表共用同一份** —— 改它等于同时改两页(见 sessionTree.ts)
import { buildGroups, indentOf, type DirGroup } from "../sessionTree";
import type { ChatMessage, CodexThreadSummary } from "../shared";
import { theme } from "../theme";
import { baseName, errText } from "../util";

/**
 * Codex 的会话列表 —— 会话页切到 Codex 时看到的那一屏。
 *
 * ## 为什么不并入 Claude 那个列表
 *
 * 两者看着像,但**能力不一样**:Claude 那边是"两段式打开"(先铺历史再起进程)、
 * 权限模式、产物…Codex 这边是**进程外的会话**(由电脑上那个常驻的 app-server 管),
 * 没有 resume 语义。混进同一个列表就得处处分叉,而使用者要的是"知道自己在看哪一边"。
 * 所以用顶部的切换分开(见 `SessionsTab`)。
 *
 * ## ⚠️ 但**长相与手感要和 Claude 那页一致**
 *
 * 2026-09-28:这一页原来只有"搜索框 + 平铺列表 + 一行红字",于是切过来像换了个 App。
 * 现在补齐了 Claude 那页有的那些:**内存缓存**(切 tab 回来立刻有东西,不再闪空态)、
 * **按目录分组的树**(缩进/折叠/计数/竖线)、**归档组**、**长按改名与归档**、
 * **新建会话**、**加载态**、**错误 banner**(不再是裸的一行红字)。
 *
 * 顶部那条、行、空态、分隔线、各个样式数值 —— 全照 `SessionsScreen` 抄。
 * 改这里之前先去看那一页的对应段落(`mobile/CLAUDE.md` 有一条硬约定:两页差只该在内容上)。
 */
const CACHE_KEY = "codex-sessions";

/**
 * 折叠状态。
 *
 * ⚠️ 键名必须与 Claude 那份(`sessions-collapsed`)**不一样**:`cache.ts` 是按 key
 * 全局的,共用会把两套列表的折叠串在一起(折了 Claude 的项目,切到 Codex 一看也折了)。
 */
const COLLAPSE_KEY = "codex-collapsed";

/** 归档组的哨兵路径。与 Claude 那边同一条手法,值不同 —— 两页各管各的 */
const ARCHIVED_PATH = "\u0000archived-codex";

/** 列表一页拉多少。与后端 `LIST_PAGE` 一致 */
const PAGE = 60;

export function CodexSessionsScreen({
  api,
  onOpen,
  reloadToken = 0,
}: {
  api: Api;
  onOpen: (thread: CodexThreadSummary, seed?: ChatMessage[]) => void;
  reloadToken?: number;
}) {
  // 先用上次的结果把界面铺上,请求回来了再覆盖 —— 切 tab 回来时不会空一下
  const [threads, setThreads] = useState<CodexThreadSummary[] | null>(() =>
    peek<CodexThreadSummary[]>(CACHE_KEY),
  );
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(peek<string[]>(COLLAPSE_KEY) ?? []),
  );

  /** 往下翻页的游标(`null` = 到头了) */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  /**
   * 拉一页。
   *
   * ⚠️ 搜索走**服务端**(Codex 自己的 `searchTerm`,探针实测是真过滤)—— 所以本地
   * 过滤那层只是**兜底**:服务端搜的是标题,而使用者可能记得的是目录名或摘要里的话。
   */
  const load = useCallback(
    async (q?: string) => {
      setBusy(true);
      try {
        const page = await api.codexThreads({ q: q?.trim() || undefined, limit: PAGE });
        setThreads(page.threads);
        setNextCursor(page.nextCursor);
        setError(null);
        // 与 Claude 那页同一个口径:**只缓存无搜索条件的完整列表**。
        // 搜索词千变万化,缓存它们只会白占内存(而且再进来时看到的是上次搜的结果)
        if (!q?.trim()) put(CACHE_KEY, page.threads);
      } catch (err) {
        // 常见的失败是"这台机器上没装独立的 Codex CLI" —— 后端把原因写在 body.error 里,
        // 照原样显示(那句话是给使用者看的:"去装一个")
        setError(errText(err));
        setThreads((prev) => prev ?? []);
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  // 搜索防抖 300ms(照 Claude 那页);没有搜索词时立刻发
  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, query, reloadToken]);

  /** 往下翻页。⚠️ **追加**,不是替换 —— 替换会把已经看到的那几十条全丢掉 */
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.codexThreads({ q: query.trim() || undefined, cursor: nextCursor, limit: PAGE });
      setThreads((prev) => {
        const have = new Set((prev ?? []).map((t) => t.id));
        return [...(prev ?? []), ...page.threads.filter((t) => !have.has(t.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoadingMore(false);
    }
  };

  /* ---------------------------------------------------------- 归档那一份 -- */

  /**
   * 归档那份列表。`null` = **还没拉过**。
   *
   * 与 Claude 那页同一个道理:没拉过时连条数都不显示(显示 0 是在编)—— 归档的意义
   * 就是"别让他们污染当前的会话页",一进这一屏就多打一次请求正好相反。
   */
  const [archivedList, setArchivedList] = useState<CodexThreadSummary[] | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedBusy, setArchivedBusy] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);

  const loadArchived = useCallback(async () => {
    setArchivedBusy(true);
    setArchivedError(null);
    try {
      // 不带搜索词:归档组是"翻旧账"的地方,跟着搜索框过滤只会让人以为东西丢了
      const page = await api.codexThreads({ archived: true, limit: 100 });
      setArchivedList(page.threads);
    } catch (err) {
      setArchivedError(errText(err));
      setArchivedList((prev) => prev ?? []);
    } finally {
      setArchivedBusy(false);
    }
  }, [api]);

  const toggleArchived = () => {
    const next = !archivedOpen;
    setArchivedOpen(next);
    if (next) void loadArchived();
  };

  /* ---------------------------------------------------------- 改名 / 归档 -- */

  const [renaming, setRenaming] = useState<CodexThreadSummary | null>(null);
  const [titleDraft, setTitleDraft] = useState("");

  /**
   * 改完**就地**更新那一行。
   *
   * ⚠️ 与 Claude 那边不同:那边改完会重拉(名字写在 jsonl 里、库要同步)。
   * 这边名字就落在 Codex 自己那条会话上,`thread/name/set` 返回即生效 ——
   * 重拉反而要多等一个来回(而每个来回在这条链路上是好几秒)。
   */
  const saveTitle = async (next: string) => {
    const target = renaming;
    if (!target) return;
    setError(null);
    try {
      await api.codexRenameThread(target.id, next);
      const shown = next.trim() ? next.trim() : null;
      const patch = (list: CodexThreadSummary[] | null) =>
        (list ?? []).map((t) => (t.id === target.id ? { ...t, name: shown } : t));
      setThreads((prev) => {
        const list = patch(prev);
        if (!query.trim()) put(CACHE_KEY, list);
        return list;
      });
      setArchivedList((prev) => (prev === null ? prev : patch(prev)));
      setRenaming(null);
    } catch (err) {
      setError(`改名失败:${errText(err)}`);
    }
  };

  /**
   * 归档 / 取消归档。
   *
   * ⚠️ **两份列表都重拉**,不做就地挪动(与 Claude 那边同一条理由):归档状态一变,
   * "它在不在这一份里"跟着变,就地改要同时维护两份、还得判断搜索词,漏一处就是
   * "点了没反应"。
   *
   * ⚠️ 失败时后端回的是 **409 + 一句人话**(常见原因:这条会话正开在 Codex 桌面端)。
   * 直接显示那句话 —— 它已经说清了"去那边关掉"。
   */
  const setArchived = async (target: CodexThreadSummary, want: boolean) => {
    setError(null);
    try {
      await api.codexArchiveThread(target.id, want);
      setRenaming(null);
      await load(query);
      if (archivedOpen) await loadArchived();
    } catch (err) {
      setError(`${want ? "归档" : "取消归档"}失败:${errText(err)}`);
    }
  };

  /* ---------------------------------------------------------- 新建会话 -- */

  const [showNew, setShowNew] = useState(false);
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);

  const startNew = async () => {
    if (!prompt.trim() || creating) return;
    setCreating(true);
    setError(null);
    const text = prompt.trim();
    const dir = cwd.trim();
    try {
      const created = await api.codexStartThread(dir, text);
      setShowNew(false);
      setPrompt("");
      /**
       * ⚠️ **必须自己补一条回显**。
       *
       * 第一句话是随创建请求发出去的,不走聊天页的输入框;而服务端那条流只推助手侧
       * (用户消息是我们自己发的,它不会推回来)。所以不补的话,进去只看到 Codex 的回答,
       * **看不到自己刚打的那句** —— 与 Claude 那页 `startNew` 里那段注释同一个问题。
       *
       * 用 `local-N` 的身份是有意的:重连补历史时 `mergeReseed` 会拿真身认亲。
       */
      onOpen(
        { id: created.id, name: text.slice(0, 30), cwd: dir, createdAt: null, updatedAt: null, preview: text },
        [makeLocalMessage("user", [{ type: "text", text }])],
      );
    } catch (err) {
      setError(`起不了 Codex 会话:${errText(err)}`);
    } finally {
      setCreating(false);
    }
  };

  /** 本地兜底过滤(服务端搜的是标题,这里连目录和摘要一起匹配) */
  const scanned = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = threads ?? [];
    if (!q) return all;
    const serverHit = all.filter((t) =>
      [t.name, t.preview, t.cwd].some((v) => v?.toLowerCase().includes(q)),
    );
    return serverHit.length > 0 ? serverHit : all;
  }, [threads, query]);

  // 两个取值函数就是这一页与 Claude 那页**唯一**的差别(那边是 projectPath / updatedAt)
  const groups = useMemo(
    () => buildGroups(scanned, (t) => t.cwd, (t) => t.updatedAt, collapsed),
    [scanned, collapsed],
  );

  /** 给 SectionList 的分组:目录树 + 末尾那个「已归档」组 */
  const sections = useMemo<DirGroup<CodexThreadSummary>[]>(
    () => [
      ...groups,
      {
        path: ARCHIVED_PATH,
        label: "已归档",
        depth: 0,
        count: archivedList?.length ?? 0,
        data: archivedOpen ? (archivedList ?? []) : [],
      },
    ],
    [groups, archivedOpen, archivedList],
  );

  /**
   * ⚠️ 主列表空了的时候顺手把归档那份也拉一次 —— 全都归档光了的话,这一屏会只剩
   * 一句"还没有会话",而**恢复的入口也一起没了**。与 Claude 那页同一条。
   */
  useEffect(() => {
    if (threads !== null && threads.length === 0 && archivedList === null) void loadArchived();
  }, [threads, archivedList, loadArchived]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      put(COLLAPSE_KEY, [...next]); // 顺手落盘,切 tab 回来还能恢复
      return next;
    });

  // ------------------------------------------------------------ 新建会话

  if (showNew) {
    return (
      <KeyboardAvoidingView style={styles.root} behavior="padding">
        <Header title="新建 Codex 会话" onBack={() => setShowNew(false)} />
        {/* 必须能滚:第一句话是多行输入框,长 prompt 会把「开始」顶到屏幕外(坑 33 同源) */}
        <ScrollView
          contentContainerStyle={styles.newForm}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <View>
            <Text style={styles.label}>工作目录</Text>
            <TextInput
              style={styles.input}
              value={cwd}
              onChangeText={setCwd}
              placeholder="E:\\某个项目"
              placeholderTextColor={theme.color.textFaint}
              autoCapitalize="none"
            />
            <Text style={styles.hint}>必须是电脑上存在的目录。Codex 会在它下面干活。</Text>
          </View>

          <View>
            <Text style={styles.label}>第一句话</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={prompt}
              onChangeText={setPrompt}
              placeholder="例如:看一下这个项目的结构并总结一下"
              placeholderTextColor={theme.color.textFaint}
              multiline
            />
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Btn
            label="开始"
            icon="arrow-forward"
            kind="primary"
            full
            onPress={() => void startNew()}
            loading={creating}
            disabled={!prompt.trim() || !cwd.trim()}
          />
          {/*
            ⚠️ 权限模式那一栏**故意没有**:Codex 的审批策略是 thread/turn 级参数,
            不是三档"每步问 / 自动"——硬做一个选择器只会让两边的语义对不上。
            它默认会问,审批照样推到手机上(见 CodexChatScreen)。
          */}
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ------------------------------------------------------------ 列表

  return (
    <View style={styles.root}>
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={theme.color.textFaint} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="搜索 Codex 会话…"
            placeholderTextColor={theme.color.textFaint}
            autoCapitalize="none"
          />
          {query ? (
            <Pressable onPress={() => setQuery("")} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={theme.color.textFaint} />
            </Pressable>
          ) : null}
        </View>
        <IconButton icon="add" onPress={() => setShowNew(true)} color={theme.color.accent} size={24} label="新建会话" />
      </View>

      {error ? (
        <View style={styles.banner}>
          <Ionicons name="alert-circle-outline" size={15} color={theme.color.danger} />
          <Text style={styles.bannerText}>{error}</Text>
        </View>
      ) : null}

      {threads === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.accent} />
        </View>
      ) : threads.length === 0 && (archivedList?.length ?? 0) === 0 ? (
        <Empty
          text={query ? "没有匹配的会话" : "还没有 Codex 会话。点右上角 + 开一个 —— 手机上建的,桌面端也看得到。"}
          icon="chatbubbles-outline"
        />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          stickySectionHeadersEnabled={false}
          // 行间横线。走 ItemSeparatorComponent:只在行与行之间画,缩进跟着目录层级走
          ItemSeparatorComponent={({ section }: { section: { depth: number } }) => (
            <ListSeparator inset={indentOf(section.depth)} />
          )}
          renderSectionHeader={({ section }) => {
            const isArchive = section.path === ARCHIVED_PATH;
            // 归档组**默认折着**,而且它不跟着 `collapsed` 走 —— 那个 Set 存的是"目录折叠"
            const isCollapsed = isArchive ? !archivedOpen : collapsed.has(section.path);
            // 归档组**永远可点**:它可能一条都没有,而"点开看到一句'还没有归档的会话'"
            // 正是要用来说清楚"归档的东西去哪了"
            const toggleable = isArchive || section.count > 0;
            return (
              <Pressable
                onPress={() => (toggleable ? (isArchive ? toggleArchived() : toggle(section.path)) : undefined)}
                disabled={!toggleable}
                style={({ pressed }) => [
                  styles.groupHeader,
                  { paddingLeft: indentOf(section.depth) },
                  pressed && toggleable && { backgroundColor: theme.color.surfacePress },
                ]}
              >
                <TreeGutter depth={section.depth} />
                <Ionicons
                  name={toggleable ? (isCollapsed ? "chevron-forward" : "chevron-down") : "folder-outline"}
                  size={13}
                  color={toggleable ? theme.color.textDim : theme.color.textFaint}
                />
                <Text
                  style={[styles.groupTitle, section.depth > 0 && styles.groupTitleChild]}
                  numberOfLines={1}
                >
                  {section.label}
                </Text>
                {/* ⚠️ 归档组在没拉过之前**不显示条数** —— 那时候的 0 是"不知道",不是"没有" */}
                {isArchive ? (
                  archivedBusy && archivedList === null ? (
                    <ActivityIndicator size="small" color={theme.color.textFaint} />
                  ) : archivedList === null ? null : (
                    <Text style={styles.groupCount}>{archivedList.length}</Text>
                  )
                ) : isCollapsed || section.count === section.data.length ? (
                  <Text style={styles.groupCount}>{section.count}</Text>
                ) : (
                  <Text style={styles.groupCount}>
                    {section.data.length}/{section.count}
                  </Text>
                )}
              </Pressable>
            );
          }}
          renderSectionFooter={({ section }) =>
            section.path !== ARCHIVED_PATH || !archivedOpen ? null : archivedBusy ? (
              <View style={styles.archiveNote}>
                <ActivityIndicator size="small" color={theme.color.accent} />
              </View>
            ) : archivedError ? (
              <Text style={[styles.archiveNote, styles.archiveError]}>没拿到归档列表:{archivedError}</Text>
            ) : (archivedList ?? []).length === 0 ? (
              <Text style={styles.archiveNote}>
                还没有归档的会话。长按任意一条,在弹出面板里可以把它收进来 ——
                归档不删任何东西,只是不在这里占地方。
              </Text>
            ) : undefined
          }
          renderItem={({ item, section }) => {
            const isArchive = section.path === ARCHIVED_PATH;
            return (
              <Pressable
                /*
                  ⚠️ 归档组里,点整行 = **恢复**(与 Claude 那页同一个语义:那一组的用途就是
                  "把不要的收起来",进去之后唯一常做的事就是把它捞回来)。
                */
                onPress={() => (isArchive ? void setArchived(item, false) : onOpen(item))}
                /*
                  ⚠️ 长按 = 改名/归档。挂在**行上**而不是那一小块标题上 —— 这一行最大的靶子
                  就是它自己(坑 35:只把 onPress 给右边小图标的写法,点标题毫无反应)。
                */
                onLongPress={() => {
                  setTitleDraft(item.name ?? "");
                  setRenaming(item);
                }}
                style={({ pressed }) => [
                  styles.sessionRow,
                  { paddingLeft: indentOf(section.depth) },
                  pressed && { backgroundColor: theme.color.surfaceAlt },
                ]}
              >
                <TreeGutter depth={section.depth} />
                <Text style={styles.itemTitle} numberOfLines={1}>
                  {item.name ?? (item.preview ? item.preview.slice(0, 40) : "(空会话)")}
                </Text>
                {/* 形状与 Claude 那页一致(那边是「N 条 · 时间」)。Codex 不给条数,
                    用目录末段顶上 —— 它同时也是分组的依据,看着不突兀 */}
                <Text style={styles.itemMeta} numberOfLines={1}>
                  {item.cwd ? `${baseName(item.cwd)} · ` : ""}
                  {formatTime(item.updatedAt)}
                </Text>
                {isArchive ? (
                  // 角标即提示:这一行点下去会发生什么,看它就知道(坑 35 那条约定)
                  <View style={styles.restorePill}>
                    <Text style={styles.restoreText}>恢复</Text>
                  </View>
                ) : (
                  <Ionicons name="chevron-forward" size={15} color={theme.color.textFaint} />
                )}
              </Pressable>
            );
          }}
          /**
           * 「加载更多」。首屏 60 条,再往下就得自己点 ——
           * ⚠️ 做成按钮而不是"滑到底自动加载":自动加载会在你正读着的时候插进一大段,
           * 而且它一旦失败就静默卡住(与 Claude 那边「加载更早」同一条取舍)。
           */
          ListFooterComponent={
            nextCursor && !query.trim() ? (
              <Pressable onPress={() => void loadMore()} disabled={loadingMore} style={styles.loadMore}>
                <Text style={styles.loadMoreText}>
                  {loadingMore ? "正在加载…" : "加载更多"}
                </Text>
              </Pressable>
            ) : undefined
          }
        />
      )}

      {busy && threads === null ? (
        <View style={styles.overlay}>
          <ActivityIndicator color={theme.color.accent} size="large" />
          <Text style={styles.overlayText}>正在读 Codex 会话…</Text>
        </View>
      ) : null}

      {/* 长按某个会话 → 改名 + 归档。合成一个面板(与 Claude 那页同一条) */}
      <Sheet
        visible={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title="会话名称"
        subtitle="写进电脑上那条 Codex 会话,桌面端也看得到"
      >
        <SheetInput
          value={titleDraft}
          onChangeText={setTitleDraft}
          placeholder="给它起个名字"
          autoFocus
          maxLength={120}
          selectTextOnFocus
        />
        <Btn
          label="保存"
          kind="primary"
          full
          disabled={!titleDraft.trim() || titleDraft.trim() === (renaming?.name ?? "")}
          onPress={() => void saveTitle(titleDraft)}
        />
        {/* 恢复默认名 = 把自定义名抹掉,回落到 Codex 给的摘要那行。不是"取消" */}
        <Btn label="恢复默认名" kind="quiet" full onPress={() => void saveTitle("")} />
        <Btn
          label="归档(先从列表里收起来)"
          icon="archive-outline"
          kind="quiet"
          full
          onPress={() => renaming && void setArchived(renaming, true)}
        />
        <Text style={styles.sheetNote}>
          归档不删任何东西:这条会话在电脑上原样留着,只是不再占列表的地方。
          ⚠️ 正开在 Codex 桌面端的那条归档不了 —— 先在那边关掉。
        </Text>
        <Btn label="取消" kind="quiet" full onPress={() => setRenaming(null)} />
      </Sheet>
    </View>
  );
}

/**
 * ⚠️ **这份样式是照着 `SessionsScreen` 抄的**,别随手改数值 ——
 * 两页看起来一样靠的就是它。要改外观,先去看那一页同名的那一处(改一处就要两处一起改)。
 */
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },

  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.gutter,
    paddingTop: theme.space(2),
    paddingBottom: theme.space(3),
  },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    paddingHorizontal: theme.space(3),
    height: 42,
  },
  searchInput: { flex: 1, color: theme.color.text, fontSize: theme.font.size.sm, padding: 0 },

  listContent: { paddingBottom: theme.space(6) },
  loadMore: { alignItems: "center", paddingVertical: theme.space(4) },
  loadMoreText: { color: theme.color.accent, fontSize: theme.font.size.sm },

  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingRight: theme.gutter,
    paddingVertical: theme.space(2),
    minHeight: 34,
  },
  groupTitle: {
    color: theme.color.textDim,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.medium,
    fontFamily: theme.font.mono,
    flexShrink: 1,
  },
  /** 子目录弱一档,一眼能看出它属于上面那个根 */
  groupTitleChild: { color: theme.color.textFaint },
  groupCount: { color: theme.color.textFaint, fontSize: theme.font.size.xs, marginLeft: "auto" },

  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingHorizontal: theme.gutter,
    paddingVertical: theme.space(3),
  },
  itemTitle: { color: theme.color.text, fontSize: theme.font.size.md, fontWeight: theme.font.weight.medium, flex: 1 },
  itemMeta: { color: theme.color.textFaint, fontSize: theme.font.size.xs, flexShrink: 0 },

  /** 归档组里那一行右侧的「恢复」(与 Claude 那页同一个药丸形状) */
  restorePill: {
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    paddingHorizontal: theme.space(3),
    paddingVertical: 3,
  },
  restoreText: { color: theme.color.textDim, fontSize: theme.font.size.xs },
  /** 归档组展开后的说明(空态 / 出错 / 加载中),缩进和会话行的标题对齐 */
  archiveNote: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
    lineHeight: 17,
    paddingLeft: indentOf(0),
    paddingRight: theme.gutter,
    paddingVertical: theme.space(3),
  },
  archiveError: { color: theme.color.danger },
  sheetNote: { color: theme.color.textFaint, fontSize: theme.font.size.xs, lineHeight: 17 },

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
  multiline: { minHeight: 110, textAlignVertical: "top" },
  newForm: {
    padding: theme.gutter,
    gap: theme.space(5),
    paddingBottom: theme.space(10),
  },
  hint: { color: theme.color.textFaint, fontSize: theme.font.size.xs, marginTop: theme.space(2), lineHeight: 17 },
  error: { color: theme.color.danger, fontSize: theme.font.size.sm },

  /** 错误条。形状借用 Claude 那页的 banner —— 不再是裸的一行红字 */
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.space(2),
    marginHorizontal: theme.gutter,
    marginBottom: theme.space(2),
    padding: theme.space(3),
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.dangerSoft,
  },
  bannerText: { color: theme.color.danger, fontSize: theme.font.size.sm, flex: 1, lineHeight: 18 },

  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.color.overlay,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space(3),
  },
  overlayText: { color: theme.color.textDim, fontSize: theme.font.size.sm },
});
