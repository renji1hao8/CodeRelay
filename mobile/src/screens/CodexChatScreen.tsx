import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import type { Api } from "../api";
import { MAX_IMAGES_PER_MESSAGE } from "../shared";
import { ApprovalCard } from "../components/ApprovalCard";
import { ArtifactCard, ArtifactPreview } from "../components/ArtifactCard";
import { ImageTierSheet } from "../components/ImageTierSheet";
import { MessageBubble, messageText } from "../components/MessageBubble";
import { ToolGroup, groupMessages, groupTurns, type Turn } from "../components/ToolGroup";
import { Btn, Header, IconButton, Sheet, formatSize } from "../components/ui";
import {
  DEFAULT_IMAGE_TIER,
  compressImage,
  pickRawImage,
  tierOf,
  type ImageTierId,
  type PickedImage,
  type RawImage,
} from "../imagePick";
import { CLIPBOARD_MAX_CHARS } from "../limits";
import { loadImageTier, saveImageTier } from "../storage";
import { deriveCodexPhase, tokensLabel, withStreaming } from "../codexChat";
import type { ArtifactDetail, ArtifactSummary, ChatMessage, CodexThreadSummary } from "../shared";
import { theme } from "../theme";
import { useCodexStream, type CodexOutgoingImage } from "../useCodexStream";
import { useKeyboardHeight } from "../useKeyboardHeight";
import { baseName, errText } from "../util";

/** 选中的待发附件(非图片)。与 `ChatScreen` 里那个同形 */
interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

/**
 * Codex 会话的聊天页。
 *
 * ## 为什么另写一个,而不是复用 `ChatScreen`
 *
 * `ChatScreen` 里写死了**权限模式选择器、问答卡、提权红卡、斜杠命令本地路由、
 * 改名、会话设置面板** —— Codex 要么没有,要么语义对不上。要复用得先把那一堆逐个
 * 门控掉,而那条路径是被坑 31/40 反复调出来的,为一个新提供商去动它不划算。
 *
 * ## 但**外壳与手感必须和 ChatScreen 一样**
 *
 * 复用的是渲染层(`MessageBubble` / `groupMessages` / `groupTurns` / `ToolGroup` /
 * `ApprovalCard` / `ArtifactCard`)。而**页面骨架**是照 `ChatScreen` 抄的 ——
 * 头部那条、`KeyboardAvoidingView` 与安全区、运行中的指示条、错误条、输入区、
 * **贴底跟随与"跳到底"那个按钮**、**长按复制**、**加载更早**,连样式都逐条对着它写。
 *
 * ⚠️ 2026-09-28 补齐的就是后半截:在那之前这一页是"能说话,但往上翻会被流式输出
 * 一直拽回底部、复制不了、看不到更早的、发不了图和文件",而且**底部少了安全区**,
 * 输入框会被导航栏压住(那是功能性缺陷,不只是不好看)。
 */
/** 离底多近算"还贴着底"。超过就认为用户在看历史,不再自动跟随 */
const STICK_THRESHOLD = 80;

export function CodexChatScreen({
  api,
  thread,
  seed,
  onBack,
}: {
  api: Api;
  thread: CodexThreadSummary;
  /** 手工铺上的头几条(新建会话时用,见 SessionsTab 的说明) */
  seed?: ChatMessage[];
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const kbHeight = useKeyboardHeight();
  const keyboardUp = kbHeight > 0;
  const stream = useCodexStream(api, thread.id, seed);
  const [draft, setDraft] = useState("");
  const [showJump, setShowJump] = useState(false);
  const [copyFor, setCopyFor] = useState<ChatMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null);
  const [artifactsComplete, setArtifactsComplete] = useState(true);
  const [artifactDetail, setArtifactDetail] = useState<ArtifactDetail | null>(null);
  const [showArtifacts, setShowArtifacts] = useState(false);
  /** 已选好但还没发出去的图 */
  const [images, setImages] = useState<PickedImage[]>([]);
  /** 已选待发的**非图片**附件 */
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  /** 正在上传附件时的进度文案。大文件要几秒,不显示的话会让人以为按了没反应 */
  const [uploading, setUploading] = useState<string | null>(null);
  /**
   * **上次**选的档位 —— 只用来给那张卡片做预选。
   *
   * ⚠️ 档位不是设置项:**每张图问一次**(见 ImageTierSheet 的说明)。不同图该压到什么
   * 程度本来就不一样,把"上次选的"预选上之后,常见情况就是看一眼、点一下。
   */
  const [lastTier, setLastTier] = useState<ImageTierId>(DEFAULT_IMAGE_TIER);
  useEffect(() => {
    void loadImageTier().then((v) => setLastTier(tierOf(v).id));
  }, []);
  /** 正在问档位的那张图。`index` 非空 = 在改待发区里已有的那一张 */
  const [tierAsk, setTierAsk] = useState<{
    raw: RawImage;
    index: number | null;
    tier: ImageTierId;
    /** 当前档位**压完**的样子 —— 它同时就是最后要发出去的那份,不白压 */
    preview: PickedImage | null;
  } | null>(null);
  const [compressing, setCompressing] = useState(false);
  const listRef = useRef<FlatList<Turn>>(null);

  // 用 ref 而不是 state 承载"是否贴底":滚动事件每帧都来,走 state 会把它变成渲染风暴
  const atBottomRef = useRef(true);
  /**
   * 用户有没有**自己**滚过。
   *
   * ⚠️ 不能只看"离底多远"(与 `ChatScreen` 同一条):打开一个大会话时内容还在逐帧长高,
   * 最开始那几帧 `onScroll` 报出来的距离必然大于阈值 —— 于是"贴底"被误判成 false,
   * 列表就停在中间不动了。这是"进去不在最底下"的根因。
   */
  const userScrolledRef = useRef(false);

  const messages = useMemo(() => withStreaming(stream), [stream]);
  const turns = useMemo(() => groupTurns(groupMessages(messages)), [messages]);

  /**
   * 正在跑的那一组工具 —— 画成琥珀色(与 Claude 那边同一个判据)。
   * 只看最后一轮:正在跑的只可能在末尾。
   */
  const liveToolsKey = useMemo(() => {
    if (!stream.busy) return null;
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (!turn || turn.kind !== "assistant") continue;
      for (let j = turn.items.length - 1; j >= 0; j--) {
        const it = turn.items[j];
        if (it && it.kind === "tools") return it.key;
      }
      return null;
    }
    return null;
  }, [turns, stream.busy]);

  const scrollToBottom = useCallback((animated = true) => {
    atBottomRef.current = true;
    setShowJump(false);
    listRef.current?.scrollToEnd({ animated });
  }, []);

  // 换会话时先跳到底。种子消息是同步铺上去的,等一帧才量得到内容高度
  useEffect(() => {
    atBottomRef.current = true;
    userScrolledRef.current = false;
    setShowJump(false);
    const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 60);
    return () => clearTimeout(timer);
  }, [thread.id]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // 还没被用户碰过 → 内容在长,位置不算数
    if (!userScrolledRef.current) return;
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
    const atBottom = distance <= STICK_THRESHOLD;
    atBottomRef.current = atBottom;
    setShowJump((prev) => (prev === !atBottom ? prev : !atBottom));
  };

  /**
   * 选图 → 先问档位、再压。**不点头连压都不压**(见 `ImageTierSheet` 的说明)。
   * 与 `ChatScreen` 那一套是同一份判据与同一份理由,只是这里的结果要**先传到电脑上**。
   */
  const attach = async () => {
    // 压图和编码要几百毫秒,期间再点会叠出多个选择器
    if (picking) return;
    if (images.length >= MAX_IMAGES_PER_MESSAGE) {
      setPickError(`一条消息最多带 ${MAX_IMAGES_PER_MESSAGE} 张图`);
      return;
    }
    setPicking(true);
    setPickError(null);
    const out = await pickRawImage();
    setPicking(false);

    if (out.kind === "cancelled") return;
    if (out.kind === "error") {
      setPickError(out.message);
      return;
    }
    void askTier(out.raw, null, lastTier);
  };

  /** 打开卡片:先按某个档位压一份**预览**(预览必须是"压完的样子",见 ChatScreen 的说明) */
  const askTier = async (raw: RawImage, index: number | null, tier: ImageTierId) => {
    setTierAsk({ raw, index, tier, preview: null });
    setCompressing(true);
    const out = await compressImage(raw, tierOf(tier));
    setCompressing(false);
    if (out.kind === "error") {
      setPickError(out.message);
      setTierAsk(null);
      return;
    }
    // 压图这条路不会返回 cancelled,但类型上要收口
    if (out.kind !== "ok") return;
    const image = out.image;
    setTierAsk((prev) => (prev && prev.raw.uri === raw.uri ? { ...prev, preview: image } : prev));
  };

  /** 换一档:重压一份预览,但**不关卡片** —— 就是要让人对着比 */
  const previewTier = async (tierId: ImageTierId) => {
    const ask = tierAsk;
    if (!ask) return;
    setCompressing(true);
    const out = await compressImage(ask.raw, tierOf(tierId));
    setCompressing(false);
    if (out.kind === "error") {
      setPickError(out.message);
      return;
    }
    if (out.kind !== "ok") return;
    const image = out.image;
    setTierAsk((prev) =>
      prev && prev.raw.uri === ask.raw.uri ? { ...prev, tier: tierId, preview: image } : prev,
    );
  };

  /** 定了:那份预览本身就是压好的图,直接放进待发区 */
  const confirmTier = () => {
    const ask = tierAsk;
    const image = ask?.preview;
    if (!ask || !image || ask.tier !== image.tier) return;
    setImages((prev) =>
      ask.index === null
        ? [...prev, image].slice(0, MAX_IMAGES_PER_MESSAGE)
        : prev.map((x, i) => (i === ask.index ? image : x)),
    );
    setLastTier(ask.tier);
    void saveImageTier(ask.tier);
    setTierAsk(null);
  };

  /**
   * 选手机上的任意文件当附件。
   *
   * 不压不转,原样上传 —— 跟图不一样:图要压是因为要当**图**发出去,
   * 而这些文件只是"放到电脑上让 Codex 去读",动它就等于改内容。
   */
  const pickFile = async () => {
    if (picking) return;
    setPicking(true);
    setPickError(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
      if (picked.canceled) return;
      const next: PickedFile[] = (picked.assets ?? []).map((a) => ({
        uri: a.uri,
        name: a.name,
        mimeType: a.mimeType ?? "application/octet-stream",
        size: a.size ?? 0,
      }));
      if (next.length > 0) setFiles((prev) => [...prev, ...next]);
    } catch (err) {
      setPickError(errText(err));
    } finally {
      setPicking(false);
    }
  };

  /**
   * 发一句话(可带图和文件)。
   *
   * ⚠️ **附件先传上去**,再把结果拼成要发的东西 —— 与 Claude 那页的 send 同一条骨架,
   * 但落点不同:
   * - **图** → 传上去拿到**电脑上的路径**,走 `localImage`(所以下面 `stream.send` 收的是路径);
   * - **文件** → 同样传上去,但**把路径拼进正文** —— Codex 的 `mention` 也能干这件事,
   *   而"路径写在正文里"有个额外好处:**本地回显与服务端记下的正文完全一致**
   *   (用 mention 的话服务端那条消息渲染出来是另一副样子,重连时可能会多出一个气泡)。
   *
   * 传失败就整个中止,草稿和已选的东西都留着 —— 否则打完一长段话、选好文件,
   * 一次网络抖动就全没了(与 Claude 那页同一条)。
   */
  const send = async () => {
    const text = draft.trim();
    // 只发图不打字是合法的("这张图什么问题"),只发文件也一样
    if ((!text && images.length === 0 && files.length === 0) || uploading) return;

    let finalText = text;
    const sendingImages: CodexOutgoingImage[] = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        setUploading(`正在上传附件 ${i + 1}/${files.length}:${f.name}`);
        const res = await api.attach(f);
        const path = res.files[0]?.path;
        if (path) {
          finalText = [finalText, "已附加文件:", path].filter(Boolean).join("\n");
        }
      }
      for (let i = 0; i < images.length; i++) {
        const img = images[i]!;
        setUploading(`正在上传图片 ${i + 1}/${images.length}`);
        const res = await api.attach({
          uri: img.uri,
          name: `image-${Date.now()}-${i}.jpg`,
          mimeType: img.mediaType,
        });
        const path = res.files[0]?.path;
        if (path) {
          sendingImages.push({
            path,
            localUri: img.uri,
            mediaType: img.mediaType,
            size: img.size,
          });
        }
      }
    } catch (err) {
      setUploading(null);
      setPickError(`附件没传上去,消息也没发:${errText(err)}`);
      return;
    }
    setUploading(null);

    const restoredImgs = images;
    const restoredFiles = files;
    setDraft("");
    setImages([]);
    setFiles([]);
    setPickError(null);

    // ⚠️ 发不出去就把草稿和附件**还回来** —— 不然界面看着像"我发了",其实一个字都没出去
    if (!stream.send(finalText, sendingImages)) {
      setDraft(text);
      setImages(restoredImgs);
      setFiles(restoredFiles);
      setNotice("连接已断开,这条没发出去 —— 等它重连上再试一次");
      return;
    }
    setNotice(null);
    // 自己刚发的消息理应跟到底
    scrollToBottom();
  };

  /**
   * 复制一条消息。
   *
   * ⚠️ 安卓的剪贴板 buffer 只有 4096 字符,超了会被**静默截断** —— 而截断比失败更糟:
   * 拿到的是半截内容还不知道少了什么。所以超过阈值改走"存成电脑上的文件 + 复制路径"。
   * 与 `ChatScreen.tsx::copyMessage` 同一份判据与同一句提示。
   */
  const copyMessage = async (message: ChatMessage) => {
    setCopyFor(null);
    const text = messageText(message);
    if (!text) return;
    try {
      if (text.length <= CLIPBOARD_MAX_CHARS) {
        await Clipboard.setStringAsync(text);
        setNotice(`已复制(${text.length} 字)`);
      } else {
        const hint = message.role === "user" ? "我的提问" : "回答";
        const { path } = await api.exportText(text, hint);
        await Clipboard.setStringAsync(path);
        setNotice(`内容较长(${text.length} 字),已存成文件并复制路径:\n${path}`);
      }
    } catch (err) {
      setNotice(`复制失败:${errText(err)}`);
    }
  };

  /**
   * 这条会话动过哪些文件。
   *
   * ⚠️ 与 Claude 那边**是两条数据来源**:它扫 jsonl,这边翻 `fileChange` item
   * (见 `server/src/codex/artifacts.ts`)。但界面、卡片、预览、下载**全都复用**。
   */
  const loadArtifacts = useCallback(async () => {
    try {
      const res = await api.codexArtifacts(thread.id);
      setArtifacts(res.artifacts);
      setArtifactsComplete(res.complete);
    } catch (err) {
      setNotice(errText(err));
    }
  }, [api, thread.id]);

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

  const phase = deriveCodexPhase(stream);
  const phaseColor =
    phase.kind === "approval" ? theme.color.warn : phase.kind === "idle" ? theme.color.textFaint : theme.color.accent;
  // 只发图或只发文件也是合法的(与 Claude 那页同判据);上传中不许再点
  const canSend = (draft.trim().length > 0 || images.length > 0 || files.length > 0) && !uploading;
  // 卡片用:高亮哪一档、以及那份预览对应的是哪一档(重压的过程中两者会短暂不一致)
  const askTierId: ImageTierId = tierAsk?.tier ?? lastTier;
  const askPreviewTier: ImageTierId = tierAsk?.preview?.tier ?? askTierId;

  /**
   * ⚠️ 优先用**拉回来的**那一份:从通知深链进来时,调用方手上那个 `thread` **只有 id**
   * (它不去多打一次接口 —— 那会把整份历史一起拉回来)。名字等这里补上。
   */
  const shown = stream.thread ?? thread;
  const title = shown.name ?? (shown.preview ? shown.preview.slice(0, 24) : "Codex 会话");

  // ------------------------------------------------------------ 产物详情
  //
  // 与 Claude 那页一样:产物属于会话,所以它是**顶掉**对话,而不是另开一个页面 ——
  // 退出去就是上下文本身。

  if (artifactDetail) {
    const name = baseName(artifactDetail.path) || "产物";
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <Header
          title={name}
          subtitle={formatSize(artifactDetail.size)}
          onBack={() => setArtifactDetail(null)}
          right={
            <IconButton
              icon="download-outline"
              label="下载到手机"
              onPress={() => void Linking.openURL(api.fileUrl(artifactDetail.path))}
            />
          }
        />
        <ScrollView contentContainerStyle={{ padding: theme.space(4), paddingBottom: theme.space(8) }}>
          <ArtifactPreview
            detail={artifactDetail}
            imageUrl={artifactDetail.kind === "image" ? api.fileUrl(artifactDetail.path, true) : null}
          />
          <View style={{ marginTop: theme.space(4), gap: theme.space(2) }}>
            <Btn
              label="下载到手机"
              icon="download-outline"
              kind="primary"
              full
              onPress={() => void Linking.openURL(api.fileUrl(artifactDetail.path))}
            />
            <Btn
              label="复制路径"
              icon="link-outline"
              full
              onPress={() => {
                void Clipboard.setStringAsync(artifactDetail.path);
                setNotice(`已复制路径:${artifactDetail.path}`);
              }}
            />
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* 头部:返回 + 标题 + 状态点。形状照 ChatScreen,少了它的产物/菜单那两个按钮 */}
      <View style={styles.header}>
        <IconButton icon="chevron-back" onPress={onBack} size={22} />
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor: stream.loading
                    ? theme.color.warn
                    : stream.connected
                      ? theme.color.ok
                      : theme.color.danger,
                },
              ]}
            />
            <Text style={styles.sub} numberOfLines={1}>
              {stream.loading ? "正在读历史…" : stream.connected ? "已连接" : "重连中"}
              {shown.id ? ` · ${shown.id.slice(0, 8)}` : ""}
              {tokensLabel(stream.tokens)}
            </Text>
          </View>
        </View>
        <View style={styles.headerBtns}>
          {/* 有产物才显示 —— 与 Claude 那页同一个位置、同一个图标 */}
          {artifacts && artifacts.length > 0 ? (
            <IconButton
              icon="albums-outline"
              label={`本会话的产物,${artifacts.length} 个`}
              onPress={() => {
                void loadArtifacts();
                setShowArtifacts(true);
              }}
              size={22}
              color={theme.color.accent}
            />
          ) : null}
        </View>
      </View>

      {stream.error ? (
        <View style={styles.errorBar}>
          <Ionicons name="alert-circle-outline" size={15} color={theme.color.danger} />
          <Text style={styles.errorText}>{stream.error}</Text>
        </View>
      ) : null}

      {/* 复制结果 / 发不出去的提示。点一下消掉 */}
      {notice ? (
        <Pressable onPress={() => setNotice(null)} style={[styles.errorBar, styles.noticeBar]}>
          <Ionicons name="checkmark-circle-outline" size={15} color={theme.color.ok} />
          <Text style={[styles.errorText, { color: theme.color.ok }]}>{notice}</Text>
        </Pressable>
      ) : null}

      {phase.kind !== "idle" ? (
        <View style={styles.phaseRow}>
          {phase.kind === "approval" ? (
            <Ionicons name="lock-closed-outline" size={12} color={phaseColor} />
          ) : (
            <ActivityIndicator size={13} color={phaseColor} />
          )}
          <Text style={[styles.phaseText, { color: phaseColor }]}>{phase.text}</Text>
        </View>
      ) : null}

      {/**
       * 产物没翻到头时说一句。
       *
       * ⚠️ 别小看这一句:不说的话,使用者会以为"我明明改过那个文件"是丢了 ——
       * 而真相只是那条会话太长,我们只翻了前几页(见 `codex/artifacts.ts` 的 `MAX_SCAN_PAGES`)。
       */}
      {!artifactsComplete && artifacts && artifacts.length > 0 ? (
        <Text style={styles.truncHint}>更早的文件改动没有列进来(这条路只翻最近的若干页)。</Text>
      ) : null}

      <View style={styles.listWrap}>
        <FlatList
          ref={listRef}
          data={turns}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) =>
            item.kind === "user" ? (
              <MessageBubble message={item.message} onLongPress={() => setCopyFor(item.message)} />
            ) : (
              <View style={styles.turnWrap}>
                <View style={styles.turnBox}>
                  {item.items.map((it) =>
                    it.kind === "message" ? (
                      <MessageBubble
                        key={it.key}
                        message={it.message}
                        bare
                        onLongPress={() => setCopyFor(it.message)}
                      />
                    ) : (
                      <ToolGroup key={it.key} entries={it.entries} bare live={it.key === liveToolsKey} />
                    ),
                  )}
                </View>
              </View>
            )
          }
          contentContainerStyle={styles.listContent}
          /**
           * 「加载更早」。
           *
           * ⚠️ 它是**按钮**而不是"滑到顶自动加载":后者会在你正往上翻的时候突然插进
           * 一大段内容把视野顶走(与 Claude 那页同一条取舍)。
           */
          ListHeaderComponent={
            stream.olderCursor !== null ? (
              <Pressable
                onPress={() => void stream.loadOlder()}
                disabled={stream.loadingOlder}
                style={styles.loadOlder}
              >
                <Text style={styles.loadOlderText}>
                  {stream.loadingOlder ? "正在加载更早的消息…" : "加载更早的消息"}
                </Text>
              </Pressable>
            ) : undefined
          }
          // 往前面插内容时**把当前视野钉住** —— 不然刚加载完,正在看的那一行会被顶走
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onScroll={onScroll}
          // 用户一动手,滚动位置就从"忽略"切成"算数"
          onScrollBeginDrag={() => {
            userScrolledRef.current = true;
          }}
          scrollEventThrottle={16}
          // ⚠️ **只在本来就贴着底时才跟随**。原来这里是无条件 scrollToEnd,
          // 于是流式输出时想上翻看历史会被一直拽回来(使用者报的那条)。
          onContentSizeChange={() => {
            if (atBottomRef.current) listRef.current?.scrollToEnd({ animated: false });
          }}
          ListEmptyComponent={stream.loading ? undefined : <Text style={styles.empty}>还没有内容</Text>}
        />
        {showJump ? (
          <Pressable onPress={() => scrollToBottom()} style={styles.jumpBtn} hitSlop={6}>
            <Ionicons name="arrow-down" size={16} color={theme.color.onAccent} />
          </Pressable>
        ) : null}
      </View>

      {/*
        审批卡挂在列表**外面** —— 与 Claude 那边同一个理由:它占多高就从对话区扣多少,
        而审批恰恰是最需要立刻被看见的东西,不该被滚走。
        `ApprovalCard` 的 props 与这边的卡片形状一致,所以直接复用,一行没改。
      */}
      {stream.approvals.map((card) => (
        <ApprovalCard key={card.reqId} pending={card} onDecide={(d) => stream.answer(card.reqId, d)} />
      ))}

      {/* 附件上传进度。大文件要几秒,不显示的话会让人以为按了没反应 */}
      {uploading ? (
        <View style={styles.pickError}>
          <ActivityIndicator size="small" color={theme.color.accent} />
          <Text style={[styles.pickErrorText, { color: theme.color.accent }]}>{uploading}</Text>
        </View>
      ) : null}

      {pickError ? (
        <View style={styles.pickError}>
          <Ionicons name="alert-circle-outline" size={13} color={theme.color.danger} />
          <Text style={styles.pickErrorText}>{pickError}</Text>
        </View>
      ) : null}

      {/* 已选待发的图。横排缩略图 —— 点它可以改这一张的档位 */}
      {images.length > 0 ? (
        <View>
          <Text style={styles.thumbTier}>
            点缩略图可改这一张的档位 · 共 {images.length} 张
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.thumbStrip}
            contentContainerStyle={styles.thumbStripContent}
            keyboardShouldPersistTaps="handled"
          >
            {images.map((img, i) => (
              <Pressable
                key={`${img.uri}-${i}`}
                style={styles.thumbWrap}
                onPress={() =>
                  // 改档位要从**原图**重压,所以给的是原图那一路的 uri 和尺寸
                  void askTier(
                    { uri: img.originalUri, width: img.originalWidth, height: img.originalHeight },
                    i,
                    img.tier,
                  )
                }
                accessibilityLabel="改这一张的压缩档位"
              >
                <Image source={{ uri: img.uri }} style={styles.thumb} resizeMode="cover" />
                {/* 这一张的档位 + 压完的**实际**尺寸(与 Claude 那页同一行信息) */}
                <Text style={styles.thumbMeta} numberOfLines={1}>
                  {tierOf(img.tier).label}
                </Text>
                <Text style={styles.thumbMeta} numberOfLines={1}>
                  {img.width}×{img.height}
                </Text>
                <Pressable
                  style={styles.thumbRemove}
                  hitSlop={8}
                  onPress={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  accessibilityLabel="移除这张图"
                >
                  <Ionicons name="close" size={12} color={theme.color.text} />
                </Pressable>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* 已选待发的文件。和图并排,但只有名字 —— 文件没有能看的缩略图 */}
      {files.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.thumbStrip}
          contentContainerStyle={styles.fileStripContent}
          keyboardShouldPersistTaps="handled"
        >
          {files.map((f, i) => (
            <View key={`${f.uri}-${i}`} style={styles.fileChip}>
              <Ionicons name="document-outline" size={13} color={theme.color.accent} />
              <Text style={styles.fileChipText} numberOfLines={1}>
                {f.name}
              </Text>
              <Pressable
                hitSlop={8}
                onPress={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                accessibilityLabel="移除这个附件"
              >
                <Ionicons name="close" size={12} color={theme.color.textDim} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <View
        style={[
          styles.inputRow,
          // 键盘弹起时不要再补导航栏的高度 —— 它已经被键盘盖住了(照 ChatScreen)
          { paddingBottom: keyboardUp ? theme.space(2) : Math.max(insets.bottom, theme.space(3)) },
        ]}
      >
        <Pressable onPress={attach} disabled={picking} style={styles.attachBtn} hitSlop={6} accessibilityLabel="添加图片">
          {picking ? (
            <ActivityIndicator size="small" color={theme.color.textDim} />
          ) : (
            <Ionicons
              name="image-outline"
              size={21}
              color={images.length > 0 ? theme.color.accent : theme.color.textDim}
            />
          )}
        </Pressable>

        <Pressable
          onPress={() => void pickFile()}
          disabled={picking}
          style={styles.attachBtn}
          hitSlop={6}
          accessibilityLabel="添加文件"
        >
          <Ionicons
            name="attach"
            size={21}
            color={files.length > 0 ? theme.color.accent : theme.color.textDim}
          />
        </Pressable>

        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={stream.connected ? "说点什么,可加图或文件" : "正在连接…"}
          placeholderTextColor={theme.color.textFaint}
          multiline
          maxLength={8000}
        />
        {stream.busy ? (
          <Pressable onPress={stream.interrupt} style={styles.stopSquare} hitSlop={6} accessibilityLabel="打断">
            <Ionicons name="square" size={16} color={theme.color.danger} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => void send()}
          disabled={!canSend}
          style={[styles.sendBtn, !canSend && styles.sendBtnOff]}
          accessibilityLabel="发送"
        >
          <Ionicons name="arrow-up" size={20} color={canSend ? theme.color.onAccent : theme.color.textFaint} />
        </Pressable>
      </View>

      {/* 长按消息弹出来的复制菜单(与 Claude 那页同一个面板) */}
      <Sheet
        visible={Boolean(copyFor)}
        onClose={() => setCopyFor(null)}
        title="复制消息"
        subtitle={
          copyFor
            ? (() => {
                const n = messageText(copyFor).length;
                return n > CLIPBOARD_MAX_CHARS ? `${n} 字 · 超过剪贴板上限,将存成电脑上的文件` : `${n} 字`;
              })()
            : undefined
        }
      >
        <Btn
          label="复制"
          icon="copy-outline"
          kind="primary"
          full
          onPress={() => copyFor && void copyMessage(copyFor)}
        />
        <Btn label="取消" kind="quiet" full onPress={() => setCopyFor(null)} />
      </Sheet>

      {/* 本会话的文件改动。列表可能很长,给它自己的滚动区(照 ChatScreen) */}
      <Sheet
        visible={showArtifacts}
        onClose={() => setShowArtifacts(false)}
        title="本会话的产物"
        subtitle={artifacts ? `${artifacts.length} 个文件` : undefined}
      >
        <ScrollView style={styles.artifactScroll} contentContainerStyle={{ gap: theme.space(2) }}>
          {(artifacts ?? []).map((a) => (
            <ArtifactCard
              key={a.id}
              artifact={a}
              onPress={() => {
                setShowArtifacts(false);
                void (async () => {
                  try {
                    setArtifactDetail(await api.codexArtifact(thread.id, a.id));
                  } catch (err) {
                    setNotice(errText(err));
                  }
                })();
              }}
            />
          ))}
        </ScrollView>
        <Btn label="关闭" kind="quiet" full onPress={() => setShowArtifacts(false)} />
      </Sheet>

      {/* 发图前问一次档位:纯本地,不经过服务端(见 ImageTierSheet) */}
      <ImageTierSheet
        raw={tierAsk?.raw ?? null}
        current={askTierId}
        preview={tierAsk?.preview ?? null}
        previewTier={askPreviewTier}
        busy={compressing}
        onPick={(t) => void previewTier(t)}
        onConfirm={confirmTier}
        onCancel={() => setTierAsk(null)}
      />
    </View>
  );
}

/**
 * ⚠️ **这份样式是照着 `ChatScreen` 抄的**,别随手改数值 —— 两页看起来一样靠的就是它。
 * 要改外观,先去看 `ChatScreen` 里同名的那一处(改一处就要两处一起改)。
 * ⚠️ 尤其是**键盘避让**那几行:两页不一致的话,其中一页会被键盘盖住输入框。
 */
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    gap: theme.space(2),
  },
  title: { color: theme.color.text, fontSize: theme.font.size.md, fontWeight: theme.font.weight.semibold },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  sub: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  headerBtns: { flexDirection: "row", alignItems: "center", gap: theme.space(1) },

  errorBar: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.space(2),
    marginHorizontal: theme.gutter,
    marginBottom: theme.space(2),
    padding: theme.space(3),
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.dangerSoft,
  },
  errorText: { color: theme.color.danger, fontSize: theme.font.size.sm, flex: 1, lineHeight: 18 },
  /** 复制成功的提示条。形状借用 errorBar,只换底色 */
  noticeBar: { backgroundColor: theme.color.okSoft },
  artifactScroll: { maxHeight: 360 },

  phaseRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.gutter,
    paddingBottom: theme.space(2),
  },
  phaseText: { fontSize: theme.font.size.xs },

  listWrap: { flex: 1 },
  listContent: { paddingTop: theme.space(2), paddingBottom: theme.space(4) },
  /** 「加载更早」那一行。居中、低调 —— 它是入口,但不该抢内容的注意力 */
  loadOlder: { alignItems: "center", paddingVertical: theme.space(4) },
  loadOlderText: { color: theme.color.accent, fontSize: theme.font.size.sm },
  truncHint: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
    paddingHorizontal: theme.gutter,
    paddingBottom: theme.space(1),
  },
  empty: { color: theme.color.textFaint, fontSize: theme.font.size.sm, textAlign: "center", marginTop: theme.space(8) },

  jumpBtn: {
    position: "absolute",
    right: theme.gutter,
    bottom: theme.space(4),
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.color.accent,
    alignItems: "center",
    justifyContent: "center",
  },

  /** 一轮回答套一个大框 —— 与 Claude 那边同一条:平铺成一堆气泡会读得断断续续 */
  turnWrap: { paddingHorizontal: theme.space(3), marginBottom: theme.space(3) },
  turnBox: {
    backgroundColor: theme.color.assistantBubble,
    borderRadius: theme.radius.lg,
    padding: theme.space(3),
    gap: theme.space(2),
  },

  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.space(2),
    paddingHorizontal: theme.space(3),
    paddingTop: theme.space(2),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border,
  },
  input: {
    flex: 1,
    maxHeight: 150,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    color: theme.color.text,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3),
    fontSize: theme.font.size.md,
  },
  stopSquare: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.color.danger,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.color.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnOff: { backgroundColor: theme.color.surfaceAlt },

  /**
   * 下面这一段(附件那几块)**照 `ChatScreen` 同名样式抄** —— 逐条对齐,
   * 包括那个"缩略图下面要放一行压完的像素尺寸"的 108 高度。
   */
  attachBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  /** 缩略图上方那行:档位 + 总体积 */
  thumbTier: {
    color: theme.color.textFaint,
    fontSize: theme.font.size.xs,
    paddingHorizontal: theme.space(3),
    paddingTop: theme.space(2),
  },
  thumbStrip: { maxHeight: 108 },
  thumbStripContent: {
    gap: theme.space(2),
    paddingHorizontal: theme.space(3),
    paddingTop: theme.space(2),
  },
  thumbWrap: { width: 64, alignItems: "center", gap: 2 },
  fileStripContent: {
    gap: theme.space(2),
    paddingHorizontal: theme.space(3),
    paddingTop: theme.space(2),
    paddingBottom: theme.space(1),
    alignItems: "center",
  },
  /** 文件名条。横排、限宽,长了省略 —— 这里只是让人确认"选对了没有" */
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    maxWidth: 200,
    paddingHorizontal: theme.space(2),
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.sm,
    backgroundColor: theme.color.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
  },
  fileChipText: { color: theme.color.text, fontSize: theme.font.size.xs, flexShrink: 1 },
  thumb: { width: 64, height: 64, borderRadius: theme.radius.md, backgroundColor: theme.color.codeBg },
  thumbMeta: { color: theme.color.textFaint, fontSize: theme.font.size.xs },
  thumbRemove: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.surfacePress,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.borderStrong,
  },
  pickError: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.space(3),
    paddingTop: theme.space(2),
  },
  pickErrorText: { color: theme.color.danger, fontSize: theme.font.size.xs, flexShrink: 1 },
});
