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
import type { LiveChat } from "../../App";
import { Api } from "../api";
import { peek, put } from "../cache";
import { makeLocalMessage } from "../messageMerge";
import type { ChatMessage, PermissionMode, SessionSummary } from "../shared";
import { loadLastMode, saveLastMode } from "../storage";
import { theme } from "../theme";
import { ListSeparator } from "../components/ui";
import { TreeGutter } from "../components/TreeGutter";
// 分组那一套(缩进、折叠、计数、竖线)在 sessionTree.ts —— **Codex 那条列表共用同一份**,
// 改它等于同时改两页(见那个文件的说明)
import { buildGroups, indentOf, type DirGroup } from "../sessionTree";
import { errText } from "../util";
import { ModePicker, modeHint } from "../components/ModePicker";
import { Btn, Empty, Header, IconButton, Sheet, SheetInput, formatTime } from "../components/ui";

const CACHE_KEY = "sessions";

/**
 * 底部那个「已归档」组的**哨兵路径**。
 *
 * 它不是个目录,但分组这一套(缩进、折叠、计数、分割线)全都是按 `path` 走的,
 * 给它一个不可能与真实目录撞上的值就能整套复用。首字符用 `\u0000`:Windows 路径里
 * 不可能出现它,而真实路径都是 `E:\…` 这种。
 */
const ARCHIVED_PATH = "\u0000archived";

/**
 * 折叠状态也存一份。
 *
 * ⚠️ 切标签页会把这一屏**卸载**(App 是 `tab === "sessions" ? <SessionsScreen/> : null`),
 * 组件状态跟着没。不存的话,折好的目录切走再回来就自己展开了 —— 而"折起来"往往是
 * 为了长期把某个不关心的项目收干净,不是一次性动作。
 *
 * ⚠️ 键名必须与 Codex 那份(`codex-collapsed`)**不一样**:`cache.ts` 是按 key 全局的,
 * 共用会把两套列表的折叠状态串在一起(折了 Claude 的项目,切到 Codex 一看那个目录
 * 也跟着折了)。
 */
const COLLAPSE_KEY = "sessions-collapsed";

export function SessionsScreen({
  api,
  onOpenLive,
  reloadToken = 0,
}: {
  api: Api;
  onOpenLive: (chat: LiveChat) => void;
  /** 链路从"不通"恢复时由 App 递增。之前那次失败的请求不会自己重来,得给个明确的信号 */
  reloadToken?: number;
}) {
  // 先用上次的结果把界面铺上,请求回来了再覆盖 —— 切 tab 回来时不会空一下
  const [sessions, setSessions] = useState<SessionSummary[] | null>(() => peek<SessionSummary[]>(CACHE_KEY));
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  /**
   * 权限模式。初值取**上次用的那个**(见 storage.ts 的 loadLastMode)—— 原来是写死
   * "ask",于是续接任何一个旧会话都会把它拽回「每步问」。
   */
  const [mode, setMode] = useState<PermissionMode>("ask");
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(peek<string[]>(COLLAPSE_KEY) ?? []),
  );

  useEffect(() => {
    void loadLastMode().then((m) => {
      if (m) setMode(m);
    });
  }, []);

  /** 改了模式就顺手落盘 —— 下次进这一屏、以及续接会话时的默认值都是它 */
  const changeMode = useCallback((next: PermissionMode) => {
    setMode(next);
    void saveLastMode(next);
  }, []);

  /**
   * 正在改名的那个会话(`null` = 面板没开)。
   *
   * 名字写在**电脑上那个会话文件里**(见 api.renameSession),不是只改这一屏的显示 ——
   * 所以改完之后电脑端、以及下次打开这个会话都会是这个名字。
   */
  const [renaming, setRenaming] = useState<SessionSummary | null>(null);
  const [titleDraft, setTitleDraft] = useState("");

  /** 改完就地更新那一行(列表是读缓存的,不就地改会看到旧名字,直到下次重拉) */
  const saveTitle = async (next: string) => {
    const target = renaming;
    if (!target) return;
    try {
      const updated = await api.renameSession(target.id, next);
      setSessions((prev) => {
        const list = (prev ?? []).map((s) => (s.id === updated.id ? updated : s));
        // 和 load() 一个口径:只缓存无搜索条件的完整列表
        if (!query) put(CACHE_KEY, list);
        return list;
      });
      setArchivedList((prev) => (prev ?? []).map((s) => (s.id === updated.id ? updated : s)));
      setRenaming(null);
    } catch (err) {
      setError(`改名失败:${errText(err)}`);
    }
  };

  /* ---------------------------------------------------------- 归档 -- */

  /**
   * 归档那一份列表。
   *
   * `null` = **还没拉过**。这不是"空":没拉过时连条数都不显示(显示 0 是在编),
   * 展开的那一刻才去拉(见 toggleArchived)。归档的意义就是"别让他们污染当前的
   * 会话页",一进这一屏就多打一次请求、多渲染几十行,正好相反。
   */
  const [archivedList, setArchivedList] = useState<SessionSummary[] | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedBusy, setArchivedBusy] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);

  const loadArchived = useCallback(async () => {
    setArchivedBusy(true);
    setArchivedError(null);
    try {
      // 不带搜索词:归档组是"翻旧账"的地方,跟着搜索框一起过滤只会让人以为东西丢了
      setArchivedList(await api.sessions(undefined, 100, true));
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

  /**
   * 归档 / 取消归档。
   *
   * ⚠️ 两份列表**都重拉**,不做就地挪动。归档状态一变,"它在不在这一份里"跟着变,
   * 就地改要同时维护两份、还得判断搜索词,漏一处就是"点了没反应"。重拉一次最省心,
   * 而且不会看到中间态 —— 服务端那条路由**顺手同步了库里的行**(不只是追加 jsonl),
   * 所以列表立刻就能反映出来,不用等 2 秒节流的索引。
   */
  const setArchived = async (target: SessionSummary, want: boolean) => {
    setError(null);
    try {
      await api.archiveSession(target.id, want);
      setRenaming(null);
      await load(query);
      if (archivedOpen) await loadArchived();
    } catch (err) {
      setError(`${want ? "归档" : "取消归档"}失败:${errText(err)}`);
    }
  };

  const load = useCallback(
    async (q?: string) => {
      setError(null);
      try {
        const list = await api.sessions(q, 60);
        setSessions(list);
        // 只缓存无搜索的完整列表。搜索词是千变万化的,缓存它们只会白占内存
        if (!q) put(CACHE_KEY, list);
      } catch (err) {
        setError(errText(err));
        setSessions((prev) => prev ?? []);
      }
    },
    [api],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, query, reloadToken]);

  // 分组的两个取值函数就是这一页与 Codex 那页唯一的差别(那边是 cwd / updatedAt)
  const groups = useMemo(
    () => buildGroups(sessions ?? [], (s) => s.projectPath, (s) => s.updatedAt, collapsed),
    [sessions, collapsed],
  );

  /**
   * 给 SectionList 的分组:**目录树 + 末尾那个「已归档」组**。
   *
   * 归档组挂成"最后一段"而不是另起一个列表,是为了复用同一套滚动、分割线、缩进和
   * 折叠 —— 两个滚动容器在手机上一定会打架。
   */
  const sections = useMemo<DirGroup<SessionSummary>[]>(
    () => [
      ...groups,
      {
        path: ARCHIVED_PATH,
        label: "已归档",
        depth: 0,
        count: archivedList?.length ?? 0,
        // 没展开就是空的 —— 空 section 照样会渲染出它的标题行,正好
        data: archivedOpen ? (archivedList ?? []) : [],
      },
    ],
    [groups, archivedOpen, archivedList],
  );

  /**
   * ⚠️ **主列表空了的时候,顺手把归档那份也拉一次。**
   *
   * 全都归档光了的话,这一屏会只剩一句「还没有会话」,而**恢复的入口也一起没了** ——
   * 使用者会以为东西被删了。正常情况(主列表非空)不付这个代价。
   */
  useEffect(() => {
    if (sessions !== null && sessions.length === 0 && archivedList === null) void loadArchived();
  }, [sessions, archivedList, loadArchived]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      // 顺手落盘,下次进这一屏恢复
      put(COLLAPSE_KEY, [...next]);
      return next;
    });

  /**
   * 点一条会话就直接进对话页 —— 中间那层"先看历史再点继续"的页面没有意义,
   * 想看历史在对话页里往下翻就行。
   *
   * 续接需要两样东西:活着的 runId,和一段历史当种子。两者互不依赖,所以并排发 ——
   * 串行的话用户点完要白等一个完整来回。
   */
  const openSession = async (session: SessionSummary) => {
    setOpening(true);
    setError(null);
    const title = session.title ?? "会话";
    try {
      /**
       * 两段式打开。为什么要这么拆:
       *
       * 起 `claude` 进程(而且带 `--resume`,CC 要读整份记录)可能要好几秒 ——
       * 大会话尤其久。原来我们是**等它起完才让进页面**,于是点一下要白等。
       * 而历史其实早就拿得到(读索引,几十毫秒)。
       *
       * 所以:先用手头的历史把页面铺上(runId 给 null,说明流还没接),
       * 进程在后台起,好了再把 runId 补进去。桌面端就是这么做的。
       */
      /**
       * ⚠️ 历史**拉不到不许挡住唤醒**。
       *
       * 它是个大响应(最多 300 条消息、可能上兆),而这条链路上大响应是可能丢的 ——
       * 实测:服务端 65~136ms 就答了,手机侧却 16 秒后重试(客户端超时),最后拿不到。
       * 原来的写法是 `await` 到底,于是 App 卡在这一步、**后面的 resume 压根没执行**,
       * 界面永远停在"正在唤醒会话…"。
       *
       * 所以给它 5 秒上限:超了就先用空历史把页面铺上,进程照起 —— 内容随后由
       * useSessionStream 的重连补历史/回放帧补齐(那条路失败也不影响这一轮开工)。
       */
      /**
       * ⚠️ resume 必须**在这儿就发出去**,不能等历史落地再发。
       *
       * 上面那段注释一直说两者"并排发",而代码原本是 `await` 完历史才发 resume ——
       * 于是"正在唤醒会话…"要先把历史那个来回(或 5 秒上限)整个干等完,才轮到起进程,
       * 两者成了**串行相加**。慢的那一头恰恰是起 claude 进程(带 `--resume`,CC 要读
       * 整份记录,大会话好几秒)。先发出去,进程就在历史下载的同时起着。
       *
       * 先挂 then/catch 再 await:不然 resume 早早失败时,这个 promise 会有一小段时间
       * 没有处理器,RN 会按"未处理的拒绝"报出来。
       */
      const liveOutcome = api
        .resumeSession(session.id, null, mode, session.projectPath ?? undefined)
        .then((live) => ({ live }) as const)
        .catch((err: unknown) => ({ err }) as const);

      const detail = await Promise.race([
        api.sessionDetail(session.id).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      const seed = (detail?.messages ?? []) as ChatMessage[];
      // 首屏只有 60 条 —— 这个游标是"往上翻"唯一的入口,别漏了
      const seedOlderCursor = detail?.olderCursor ?? null;

      onOpenLive({ runId: null, title, mode, seed, seedOlderCursor });
      setOpening(false);

      const outcome = await liveOutcome;
      if ("err" in outcome) {
        // 起不来就停在"正在唤醒会话…"。这里不弹错 —— 对话页自己会说清楚,
        // 而且这时候列表页多半已经被换掉了,弹了也没人看
        console.warn("唤醒会话失败:", errText(outcome.err));
      } else {
        onOpenLive({
          runId: outcome.live.runId,
          title,
          mode,
          seed,
          seedOlderCursor,
          // ⚠️ **不看 `reused`**:服务端冷启动那条路现在也会回 `busy`(它可能是刚发出去
          // 一条 prompt 就忙起来了)。原来写成"只有复用时才带",于是重进一个正在跑的会话
          // 时界面先是空闲态 —— 没有"正在思考"、也没有暂停键,要等 `state` 帧(排在回放
          // 之后)才纠正。使用者报的就是这一段。
          reusedBusy: outcome.live.busy,
        });
      }
    } catch (err) {
      setError(errText(err));
      setOpening(false);
    }
  };

  const startNew = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    const text = prompt.trim();
    try {
      const created = await api.createSession(cwd.trim(), text, mode);
      setShowNew(false);
      setPrompt("");
      /**
       * ⚠️ **必须自己补一条回显**。
       *
       * 首条 prompt 是**随创建请求**发出去的(见后端 `/api/sessions` 里那句
       * `session.send(body.prompt)`),它不经过聊天页的输入框 —— 而服务端又只推
       * 助手侧的帧,于是这条消息在 App 里**永远不会出现**:进来就是模型的回答,
       * 看不到自己刚打的那句话。
       *
       * 用 `local-N` 的身份是有意的:重连补历史时,`mergeHistory` 会让服务端那条
       * 真身**认领并顶掉**它,位置不变、也不会多出一个气泡。
       */
      onOpenLive({
        runId: created.runId,
        title: text.slice(0, 30),
        mode,
        seed: [makeLocalMessage("user", [{ type: "text", text }])],
      });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------ 新建会话

  if (showNew) {
    return (
      <KeyboardAvoidingView style={styles.root} behavior="padding">
        <Header title="新会话" onBack={() => setShowNew(false)} />
        {/*
          ⚠️ **必须能滚**。这里原来是普通 `View`,而"第一句话"是多行输入框 ——
          一段长 prompt 会把它自己撑得很高,后面的「开始」按钮被整个顶到屏幕外,
          而外层不是滚动容器,划也划不动、点也点不到(使用者反馈的第 1 条)。
          和 Sheet 那次修法同一个道理:内容会随输入长高的地方,都得有个滚动容器兜底。
        */}
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
            <Text style={styles.hint}>必须是电脑上存在的目录,且在白名单根目录内</Text>
          </View>

          <View>
            <Text style={styles.label}>权限模式</Text>
            <ModePicker value={mode} onChange={changeMode} />
            <Text style={styles.hint}>{modeHint(mode)}</Text>
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
            loading={busy}
            disabled={!prompt.trim()}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ------------------------------------------------------------ 会话列表

  return (
    <View style={styles.root}>
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={theme.color.textFaint} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="搜索历史会话…"
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

      {sessions === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.accent} />
        </View>
      ) : sessions.length === 0 && (archivedList?.length ?? 0) === 0 ? (
        <Empty text={query ? "没有匹配的会话" : "还没有会话。点右上角 + 开一个新的。"} icon="chatbubbles-outline" />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          stickySectionHeadersEnabled={false}
          /*
            行间横线。走 `ItemSeparatorComponent`(而不是行自己的 borderBottom):
            ① 只在**行与行之间**画,最后一行后面不会留一截悬空的线;
            ② 缩进跟着目录层级走,和标题左边缘对齐 —— 通铺到左边缘在这个树形列表里很毛。
          */
          ItemSeparatorComponent={({ section }: { section: { depth: number } }) => (
            <ListSeparator inset={indentOf(section.depth)} />
          )}
          renderSectionHeader={({ section }) => {
            const isArchive = section.path === ARCHIVED_PATH;
            // 归档组不跟着 `collapsed` 走:那个 Set 存的是"目录折叠",而它有个默认值
            // 的问题 —— 归档组要求**默认折着**,往那个 Set 里塞一个初始元素只会让
            // "折叠状态"和"默认值"两件事混在一起
            const isCollapsed = isArchive ? !archivedOpen : collapsed.has(section.path);
            // 有会话就能折叠。老代码按"有没有子目录"判,于是 E:\RemoteCC\server 这种
            // 自己有会话、没有更深子目录的组显示成文件夹图标、点不动 —— 二级目录
            // 因此从来收不起来。
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
                  name={
                    toggleable
                      ? isCollapsed
                        ? "chevron-forward"
                        : "chevron-down"
                      : "folder-outline"
                  }
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
              <Text style={[styles.archiveNote, styles.archiveError]}>
                没拿到归档列表:{archivedError}
              </Text>
            ) : (archivedList ?? []).length === 0 ? (
              <Text style={styles.archiveNote}>
                还没有归档的会话。长按任意一条会话,在弹出面板里可以把它收进来 ——
                归档不删任何东西,只是不在这里占地方。
              </Text>
            ) : null
          }
          renderItem={({ item, section }) => {
            const isArchive = section.path === ARCHIVED_PATH;
            return (
              <Pressable
                /*
                  ⚠️ 归档组里,点整行 = **恢复**。
                  那一组的用途就是"把不要的收起来",进去之后唯一常做的事就是把它捞回来;
                  想读里面的内容先恢复一下也只是多一次点击。
                  (普通行仍然是"点开进对话页" —— 两边语义不同是故意的。)
                */
                onPress={() => (isArchive ? void setArchived(item, false) : void openSession(item))}
                /*
                  ⚠️ 长按 = 改名。挂在**行上**而不是那一小块标题上:这一行最大的靶子就是
                  它自己(和 IconActionRow 那次同一个道理 —— 只把 onPress 给右边小图标的
                  写法,点标题毫无反应)。
                */
                onLongPress={() => {
                  setTitleDraft(item.title ?? "");
                  setRenaming(item);
                }}
                style={({ pressed }) => [
                  styles.sessionRow,
                  // 跟着所属目录缩进,再画一小段横线接上去 —— 一眼能看出它挂在谁下面
                  { paddingLeft: indentOf(section.depth) },
                  pressed && { backgroundColor: theme.color.surfaceAlt },
                ]}
              >
                <TreeGutter depth={section.depth} />
                {/* 标题就一行,不再把上次说的那句话当小字垫在下面 —— 那行既截断又占地方。
                    titleSource 是 prompt 时说明这句话是**顶替**来的(CC 还没起标题),
                    用淡色标出来,免得"一句话"和"一个标题"看起来是一回事。 */}
                <Text
                  style={[styles.itemTitle, item.titleSource === "prompt" && styles.itemTitleFallback]}
                  numberOfLines={1}
                >
                  {item.title ?? "(无标题)"}
                  {item.titleSource === "prompt" ? "  ·未起标题" : ""}
                </Text>
                <Text style={styles.itemMeta}>
                  {item.messageCount} 条 · {formatTime(item.updatedAt)}
                </Text>
                {isArchive ? (
                  // 角标即提示:这一行点下去会发生什么,看它就知道(pitfall 35 那条约定)
                  <View style={styles.restorePill}>
                    <Text style={styles.restoreText}>恢复</Text>
                  </View>
                ) : (
                  <Ionicons name="chevron-forward" size={15} color={theme.color.textFaint} />
                )}
              </Pressable>
            );
          }}
        />
      )}

      {opening ? (
        <View style={styles.overlay}>
          <ActivityIndicator color={theme.color.accent} size="large" />
          <Text style={styles.overlayText}>正在接上会话…</Text>
        </View>
      ) : null}

      {/* 长按某个会话 → 改名 + 归档。
          ⚠️ 这两件事合成一个面板:长按那一栏就是"跟这个会话有关的操作",
          再单独为归档开一个入口,使用者得先记住"哪个是长按、哪个是右滑"。 */}
      <Sheet
        visible={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title="会话名称"
        subtitle="写进电脑上那个会话文件,电脑端也看得到"
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
          disabled={!titleDraft.trim() || titleDraft.trim() === (renaming?.title ?? "")}
          onPress={() => void saveTitle(titleDraft)}
        />
        {/* 恢复默认名 = 把自定义名抹掉,回落到 AI 起的名字(或第一句话)。不是"取消" */}
        <Btn label="恢复默认名" kind="quiet" full onPress={() => void saveTitle("")} />
        <Btn
          label={renaming?.archived ? "取消归档(放回列表)" : "归档(先从列表里收起来)"}
          icon={renaming?.archived ? "arrow-undo-outline" : "archive-outline"}
          kind="quiet"
          full
          onPress={() => renaming && void setArchived(renaming, !renaming.archived)}
        />
        <Text style={styles.sheetNote}>
          归档不删任何东西:消息、用量、文件都原样留着,只是不再占会话列表的地方。
          取消归档之后一切照旧。
        </Text>
        <Btn label="取消" kind="quiet" full onPress={() => setRenaming(null)} />
      </Sheet>
    </View>
  );
}

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

  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingRight: theme.gutter,
    paddingVertical: theme.space(2),
    minHeight: 34,
  },
  /**
   * 目录名。
   *
   * 字号跟会话标题同档(md)—— 原来是 sm,比底下的会话小两号,看起来像附属信息,
   * 而它其实是这一组的**标题**。层级改由颜色(textDim)和等宽体来区分,
   * 不再靠"小一号"。
   */
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

  // 树状竖线的样式跟着 `TreeGutter` 一起搬去了 `components/TreeGutter.tsx` ——
  // 两个列表共用那一份,别在这里再放一份

  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingHorizontal: theme.gutter,
    paddingVertical: theme.space(3),
  },
  itemTitle: { color: theme.color.text, fontSize: theme.font.size.md, fontWeight: theme.font.weight.medium, flex: 1 },
  /** 首条消息顶替来的标题:淡一档,和真正的标题区分开 */
  itemTitleFallback: { color: theme.color.textDim, fontWeight: theme.font.weight.regular },
  itemMeta: { color: theme.color.textFaint, fontSize: theme.font.size.xs, flexShrink: 0 },

  /**
   * 归档组里那一行右侧的「恢复」。
   *
   * 做成一个小药丸而不是一颗图标:这一行**点了就是恢复**(见 renderItem 里的说明),
   * 药丸是那个动作的**招牌** —— 不给招牌的话,点下去会捞出个东西来,谁也不知道
   * 这一下为什么。
   */
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
    paddingLeft: theme.gutter + 10,
    paddingRight: theme.gutter,
    paddingVertical: theme.space(3),
  },
  archiveError: { color: theme.color.danger },
  /** 长按面板底部那段"归档不删东西"的说明 */
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
  /** 新会话表单。留一点底部余量,让最后一个按钮不被导航栏压住 */
  newForm: {
    padding: theme.gutter,
    gap: theme.space(5),
    paddingBottom: theme.space(10),
  },
  hint: { color: theme.color.textFaint, fontSize: theme.font.size.xs, marginTop: theme.space(2), lineHeight: 17 },
  error: { color: theme.color.danger, fontSize: theme.font.size.sm },

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
