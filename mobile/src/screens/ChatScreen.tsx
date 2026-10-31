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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { LiveChat } from "../../App";
import type { Api } from "../api";
import { MAX_IMAGES_PER_MESSAGE, parseQuestions } from "../shared";
// 判据只有一份,和 MessageBubble 的上色共用(见 src/slashCommand.ts 的说明)
import { slashCommandOf } from "../slashCommand";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import type { PermissionMode, ChatMessage, ArtifactDetail, ArtifactSummary } from "../shared";
import {
  DEFAULT_IMAGE_TIER,
  compressImage,
  pickRawImage,
  tierOf,
  type ImageTierId,
  type PickedImage,
  type RawImage,
} from "../imagePick";
import { loadImageTier, saveImageTier, saveLastMode } from "../storage";
import { theme } from "../theme";
import { useSessionStream } from "../useSessionStream";
import { useKeyboardHeight } from "../useKeyboardHeight";
import { ApprovalCard } from "../components/ApprovalCard";
import { ElevatedCard } from "../components/ElevatedCard";
import { ImageTierSheet } from "../components/ImageTierSheet";
import { ArtifactCard, ArtifactPreview } from "../components/ArtifactCard";
import { MessageBubble, messageText } from "../components/MessageBubble";
import { ModePicker, modeHint } from "../components/ModePicker";
import { QuestionCard } from "../components/QuestionCard";
import { ToolGroup, groupMessages, groupTurns, type Turn } from "../components/ToolGroup";
import { Btn, Header, IconButton, Sheet, SheetInput, formatSize } from "../components/ui";
import { CLIPBOARD_MAX_CHARS } from "../limits";
import { baseName, errText } from "../util";

/** 选中的待发附件(非图片) */
interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

/** 离底多近算"还贴着底"。超过就认为用户在看历史,不再自动跟随 */
const STICK_THRESHOLD = 80;

/**
 * 「已消耗 N tokens」—— 取代原来头部那个美元数(使用者要的是"用了多少",
 * 美元数对他没有意义)。
 *
 * 后端发来的 `tokens` 缺失时**什么都不显示**:宁可空着,也不退回显示 `$`。
 * 缺失只会在"新 App 配还没重启的旧后端"这一种情况下发生,过一阵就自己好了。
 */
function tokensLabel(n?: number): string {
  if (!n) return "";
  const s = n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return ` · 已消耗 ${s} tokens`;
}

/**
 * 这条消息是不是"整条就是一条斜杠命令",是的话拆出名字与参数。
 *
 * ⚠️ 判据**不在这里** —— 在 `src/slashCommand.ts`,和 `MessageBubble` 的上色判据共用
 * 同一份。原来这边各写一份(这边整条锚定、那边前缀匹配),对同一个输入会给出不同答案,
 * 于是出现"看着是命令、其实被当普通消息发给了模型"这种谁也说不清的状态。
 * 统一到那份更严的判据之后:**上色的就是会被当命令处理的**,反之亦然。
 *
 * 名字已小写、不带斜杠 —— 路由只认小写(cmd 名是 ASCII,不受大小写影响)。
 */
function localSlashOf(text: string): { cmd: string; arg: string } | null {
  const parsed = slashCommandOf(text);
  return parsed ? { cmd: parsed.name, arg: parsed.args } : null;
}

export function ChatScreen({
  api,
  live,
  onClose,
  onRunIdChange,
  onTitleChange,
}: {
  api: Api;
  live: LiveChat;
  onClose: () => void;
  /**
   * 那条流在后端没了(会话被回收 / 后端重启过)时,钩子会自己 resume 一条新的,
   * 然后把新 runId 交到这里 —— 由持有 LiveChat 的那一层换掉。
   */
  onRunIdChange?: (runId: string) => void;
  /** 改完会话名之后告诉外面 —— 头部标题由持有 LiveChat 的那一层管 */
  onTitleChange?: (title: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const kbHeight = useKeyboardHeight();
  const keyboardUp = kbHeight > 0;
  const stream = useSessionStream(
    api,
    live.runId,
    live.seed,
    live.reusedBusy,
    live.mode,
    onRunIdChange,
    live.seedOlderCursor,
  );
  /**
   * 后端的 claude 进程还在起。
   *
   * 这一屏是**先用历史铺出来的**,流还没接上。所以别让人发消息 —— 发了也没地方去。
   * 页面能立刻打开正是因为不等它,见 SessionsScreen.openSession 的两段式打开。
   */
  const waking = live.runId === null;
  const [draft, setDraft] = useState("");
  const [showJump, setShowJump] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /** 长按哪条消息弹的复制菜单 */
  const [copyFor, setCopyFor] = useState<ChatMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 本会话产出的文件。收件箱改管 mail 归档后,产物回到它所属的会话里 */
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null);
  const [artifactDetail, setArtifactDetail] = useState<ArtifactDetail | null>(null);
  const [showArtifacts, setShowArtifacts] = useState(false);
  /** 已选好但还没发出去的图 */
  const [images, setImages] = useState<PickedImage[]>([]);

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
    /** 当前高亮的档位 */
    tier: ImageTierId;
    /** 当前档位**压完**的样子 —— 它同时就是最后要发出去的那份,不白压 */
    preview: PickedImage | null;
  } | null>(null);
  const [compressing, setCompressing] = useState(false);
  /**
   * 已选待发的**非图片**附件。
   *
   * 它们不能像图那样直接进消息内容块 —— Agent SDK 只认 text 与 image。
   * 所以走的是"先传到电脑上、再把路径拼进正文",见 send 里那段。
   */
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  /** 正在结束会话(等后端把子进程收掉) */
  const [ending, setEnding] = useState(false);
  /** 「结束会话」的二次确认 —— 它会掐掉正在跑的一轮,不该一击就中 */
  const [confirmEnd, setConfirmEnd] = useState(false);
  /**
   * 正在改会话名(`null` = 那个输入面板没开)。
   *
   * 名字写在**电脑上那个会话的 jsonl** 里(见 api.renameSession),所以改完电脑端
   * 也认;这里只是发起 + 立刻把界面上的标题换掉。
   */
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const listRef = useRef<FlatList<Turn>>(null);
  // 用 ref 而不是 state 承载"是否贴底":滚动事件每帧都来,走 state 会把它变成渲染风暴
  const atBottomRef = useRef(true);
  /**
   * 用户有没有**自己**滚过。
   *
   * ⚠️ 不能只看"离底多远"。打开一个大会话时内容还在逐帧长高,最开始那几帧
   * onScroll 报出来的距离必然大于阈值 —— 于是"贴底"被误判成 false,列表就停在
   * 中间不动了。这正是"进去不在最底下"的原因:不是没跳,是跳完立刻被拽回来。
   *
   * 所以在用户**主动拖动**之前,滚动位置不参与判断,一直当贴底。
   */
  const userScrolledRef = useRef(false);

  // 先按"工具组"折叠,再按"轮"切开 —— 后者让一次回答能被一个框兜住
  const turns = useMemo(() => groupTurns(groupMessages(stream.messages)), [stream.messages]);

  /**
   * 最新那一个工具组的 key —— 只有它才可能是"正在跑"。
   *
   * `ToolGroup` 靠它把"还在跑"和"结果永远不来了"分开:后者在历史会话里满地都是
   * (被中断的调用、被解析器丢掉的结果、分页截断),靠"有没有拿到结果"单个判据会把
   * 它们全画成琥珀色。见 ToolGroup 的说明。
   */
  const liveToolsKey = useMemo(() => {
    if (!stream.busy) return null;
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i]!;
      if (turn.kind !== "assistant") continue;
      for (let j = turn.items.length - 1; j >= 0; j--) {
        const it = turn.items[j]!;
        if (it.kind === "tools") return it.key;
      }
      // 最后一条回答里没有工具组 → 那最新的一组不在这后面,没有"正在跑"的
      return null;
    }
    return null;
  }, [turns, stream.busy]);

  const scrollToBottom = useCallback((animated = true) => {
    atBottomRef.current = true;
    setShowJump(false);
    listRef.current?.scrollToEnd({ animated });
  }, []);

  // 换会话(含续接历史)时先跳到底。种子消息是同步铺上去的,等一帧才量得到内容高度
  useEffect(() => {
    atBottomRef.current = true;
    userScrolledRef.current = false;
    setShowJump(false);
    const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 60);
    return () => clearTimeout(timer);
  }, [live.runId]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // 还没被用户碰过 → 内容在长,位置不算数
    if (!userScrolledRef.current) return;
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
    const atBottom = distance <= STICK_THRESHOLD;
    atBottomRef.current = atBottom;
    setShowJump((prev) => (prev === !atBottom ? prev : !atBottom));
  };

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
    // 先问档位、再压 —— 不点头连压都不压(见 ImageTierSheet 的说明)
    void askTier(out.raw, null, lastTier);
  };

  /**
   * 打开卡片:先按某个档位压一份**预览**。
   *
   * ⚠️ 预览必须是"压完的样子":手机屏幕上原图和压过的图都会被缩放进同一个框,
   * 肉眼几乎一样 —— 拿原图当预览等于什么都看不出。而模型读的是**原始像素**,所以要看的
   * 是压完的像素细节(卡片里点开可放大)。这一份同时就是最后要发出去的那份,不是额外开销。
   */
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
   * 不压不转,原样上传 —— 跟图不一样:图要压是因为要当内容块发给模型,
   * 而这些文件只是"放到电脑上让 CC 去读",动它就等于改内容。
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

  const send = async () => {
    const text = draft.trim();
    // 只发图不打字是合法的("这张图什么问题"),只发文件也一样
    if (!text && images.length === 0 && files.length === 0) return;
    if (uploading || waking) return;

    // 斜杠命令先过一道本地路由 —— 终端专用的那些发出去只会石沉大海(见 runLocalSlash)。
    // 只对"纯命令"生效:带了图或附件就说明使用者是在说话,不是在敲命令。
    if (images.length === 0 && files.length === 0 && runLocalSlash(text)) {
      setDraft("");
      return;
    }

    // 附件**先传上去**再把路径拼进正文。传失败就整个中止,草稿和已选的东西都留着 ——
    // 否则用户打完一长段话、选好文件,一次网络抖动就全没了。
    let finalText = text;
    if (files.length > 0) {
      const paths: string[] = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i]!;
          setUploading(`正在上传附件 ${i + 1}/${files.length}:${f.name}`);
          const res = await api.attach(f);
          paths.push(...res.files.map((x) => x.path));
        }
      } catch (err) {
        setPickError(`附件没传上去,消息也没发:${errText(err)}`);
        return;
      } finally {
        setUploading(null);
      }
      // 路径写进正文,CC 就是靠这几行去读文件的
      finalText = [text, "已附加文件:", ...paths].filter(Boolean).join("\n");
    }

    const sending = images;
    const sendingFiles = files;
    setDraft("");
    setImages([]);
    setFiles([]);
    setPickError(null);
    // 自己刚发的消息理应跟到底
    scrollToBottom();

    // ⚠️ 发不出去就把草稿和附件**还回来** —— 不然界面看着像"我发了",其实一个字都没出去
    if (!stream.sendUserMessage(finalText, sending)) {
      setDraft(text);
      setImages(sending);
      setFiles(sendingFiles);
      setPickError("连接已断开,这条没发出去 —— 等它重连上再试一次");
    }
  };

  // ⚠️ 不在这里改本地 state。模式以服务端为准,它每次接入都会推一帧真值回来
  // (见 useSessionStream 的 mode_changed 分支),界面跟着那一帧走。
  // 原来这里是"先改自己、再发一帧"—— 那帧一旦没送出去(切屏回来时 socket 正断着),
  // 界面就永久显示一个后端没采纳的模式,使用者看到的就是"改了好像没用"。
  //
  // 落盘的那一份是**另一个用途**:给"下次新开/续接会话"当默认值,免得每次都从
  // 「每步问」重来(见 storage.ts 的 loadLastMode)。它不参与本次会话的显示。
  const changeMode = (next: PermissionMode) => {
    stream.setMode(next);
    void saveLastMode(next);
  };

  /**
   * 服务端把"这条会话已经结束了"顶回来时,它会把**刚发出去还没被确认的那条**一并交还
   * (见 useSessionStream 的 inflightRef)。这里把它放回输入框 —— 使用者打的是一长段话,
   * 光把转圈修好还不够,内容不能丢。
   */
  useEffect(() => {
    const lost = stream.lostDraft;
    if (!lost) return;
    setDraft(lost.text);
    setImages(lost.images);
    setNotice("刚才那条没送到电脑上(会话已经结束了,正在重新唤醒)—— 内容已经放回输入框,再看一眼就能重发");
    stream.clearLostDraft();
  }, [stream.lostDraft, stream.clearLostDraft]);

  /**
   * 就地处理斜杠命令,**不往 CLI 发**。
   *
   * ⚠️ 为什么必须拦:CLI 把 `/xxx` 当命令解释,而其中一类是**交互式**的(挑会话、
   * 改状态栏、退出进程)。在 headless 的流里它们要么卡住、要么报错,而且**永远不会有
   * 回复** —— 在手机上看起来就是"消息发出去之后石沉大海"。
   *
   * 名单不靠猜:SDK 的 init 帧里有权威的一份(`terminal_slash_commands`,它自己的注释
   * 就写着 "Phone/remote UIs should hide these"),再加上我们能就地服务好的两条。
   *
   * 返回 true = 已经自己处理掉了,调用方不要再发。
   */
  const runLocalSlash = (text: string): boolean => {
    const parsed = localSlashOf(text);
    if (!parsed) return false;

    if (parsed.cmd === "exit" || parsed.cmd === "quit") {
      // 直接弹出「结束这个会话」那一段的二次确认 —— 和按钮走同一条路
      setShowSettings(true);
      setConfirmEnd(true);
      return true;
    }
    if (parsed.cmd === "resume") {
      setNotice("换会话请回「会话」列表点 —— /resume 是电脑终端里的交互命令,在这里发出去不会有回音");
      return true;
    }
    if (stream.terminalSlash.includes(parsed.cmd)) {
      setNotice(`/${parsed.cmd} 只在电脑的终端里才有意义,手机上发出去不会有回音`);
      return true;
    }
    return false;
  };

  /**
   * **主动结束这个会话** —— 让电脑上那个 claude 子进程真的退出。
   *
   * 为什么需要(使用者反馈的第 14 条):在那之前手机侧没有任何办法结束一个会话,
   * 只能等后端把空闲会话回收掉(30 分钟)。而"我改了环境变量 / 加了技能,想让它重新读
   * 一遍"是很日常的需求。结束之后再进来就是一条全新进程,环境变量、技能、CLAUDE.md
   * 全部重新加载。
   *
   * ⚠️ 它**不删聊天记录**(jsonl 才是权威源,后端那条接口也不碰它):下次进这个会话,
   * 历史照旧、接着聊。
   */
  const endSession = async () => {
    if (ending || !live.runId) return;
    setEnding(true);
    try {
      await api.closeSession(live.runId);
      setConfirmEnd(false);
      setShowSettings(false);
      onClose();
    } catch (err) {
      setNotice(`结束会话失败:${errText(err)}`);
      setConfirmEnd(false);
    } finally {
      setEnding(false);
    }
  };

  /**
   * 改会话名(空串 = 恢复默认名)。
   *
   * ⚠️ 用 `stream.ccSessionId` 而不是 `live.runId`:名字属于**那个会话文件**,
   * 而 runId 是"这一次的进程" —— 结束会话再进来,runId 会变、ccSessionId 不变。
   * 所以进程还没起来(`waking`)时不能改:那时还没拿到 ccSessionId,拿 runId 去改
   * 会落到一个后端不认识的 id 上。
   */
  const saveTitle = async (next: string) => {
    const id = stream.ccSessionId;
    if (!id) {
      setNotice("还没接上这个会话,稍等一下再改");
      return;
    }
    try {
      const updated = await api.renameSession(id, next);
      setRenaming(false);
      onTitleChange?.(updated.title ?? live.title);
      setNotice(next ? "名字改好了" : "已恢复默认名");
    } catch (err) {
      setNotice(`改名失败:${errText(err)}`);
    }
  };

  const canSend = !waking && (draft.trim().length > 0 || images.length > 0 || files.length > 0);
  // 卡片用:高亮哪一档、以及那份预览对应的是哪一档(重压的过程中两者会短暂不一致)
  const askTierId: ImageTierId = tierAsk?.tier ?? lastTier;
  const askPreviewTier: ImageTierId = tierAsk?.preview?.tier ?? askTierId;
  const pendingKb =
    images.length > 0 ? Math.max(1, Math.round(images.reduce((n, x) => n + x.size, 0) / 1024)) : 0;
  const phase = stream.phase;
  const working = phase.kind === "thinking" || phase.kind === "outputting" || phase.kind === "tool";
  const phaseColor =
    phase.kind === "approval"
      ? theme.color.warn
      : phase.kind === "question" || phase.kind === "tool"
        ? theme.color.accent
        : theme.color.textFaint;
  // 提问和审批共用一条通道,靠 input 形状分流
  const questions = stream.pending ? parseQuestions(stream.pending.input) : null;

  /**
   * 本会话产出的文件。
   *
   * 它们原来在"结果收件箱"里,但收件箱现在只管 mail 归档(由 /push 主动推过去的
   * 结果文件)。会话产出的东西留在会话里更合理 —— 看到文件和上下文在一起,想说什么
   * 直接就是一条普通消息,不用再走"批注"那条独立通道。
   */
  const ccId = stream.ccSessionId;
  const loadArtifacts = useCallback(async () => {
    if (!ccId) return;
    try {
      setArtifacts(await api.artifacts(ccId, 50));
    } catch {
      /* 产物列表拉不到不影响对话,静默 */
    }
  }, [api, ccId]);

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

  /**
   * 复制一条消息。
   *
   * ⚠️ 安卓的剪贴板 buffer 只有 4096 字符,超了会被**静默截断** —— 而截断比失败
   * 更糟:你拿到的是半截内容,还不知道少了什么。所以超过阈值就改走"存成电脑上的
   * 文件 + 复制路径":路径几十字节永远塞得下,而且存下来的是完整内容。
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

  // ------------------------------------------------------------ 产物的详情
  //
  // 产物属于会话,所以它是在这一屏里"顶掉"对话,而不是另开一个页面 ——
  // 退出去就是上下文本身,想对文件说什么直接发消息就行(不再有"批注"那条通道)。

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
      <View style={styles.header}>
        <IconButton icon="chevron-back" onPress={onClose} size={22} />
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            {live.title}
          </Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor: waking
                    ? theme.color.warn
                    : stream.connected
                      ? theme.color.ok
                      : theme.color.danger,
                },
              ]}
            />
            <Text style={styles.sub} numberOfLines={1}>
              {waking ? "正在唤醒会话…" : stream.connected ? "已连接" : "重连中"}
              {stream.ccSessionId ? ` · ${stream.ccSessionId.slice(0, 8)}` : ""}
              {tokensLabel(stream.lastResult?.tokens)}
            </Text>
          </View>
        </View>
        <View style={styles.headerBtns}>
          {/* 有产物才显示。会话产出的文件归到会话里了,这里就是入口 */}
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
          <IconButton icon="menu" onPress={() => setShowSettings(true)} size={22} />
        </View>
      </View>

      {stream.error ? (
        <View style={styles.errorBar}>
          <Ionicons name="alert-circle-outline" size={15} color={theme.color.danger} />
          <Text style={styles.errorText}>{stream.error}</Text>
        </View>
      ) : null}

      {/* 复制结果。长内容会走"存文件"那条路,通知里得把路径给出来,点一下消掉 */}
      {notice ? (
        <Pressable onPress={() => setNotice(null)} style={[styles.errorBar, styles.noticeBar]}>
          <Ionicons name="checkmark-circle-outline" size={15} color={theme.color.ok} />
          <Text style={[styles.errorText, { color: theme.color.ok }]}>{notice}</Text>
        </Pressable>
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
              // 整轮回答套在一个大框里。文本和工具调用是同一轮回答的不同部分,
              // 平铺成一堆独立气泡会读得断断续续,也看不出"这是她对我那句话的完整回复"
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
                      <ToolGroup
                        key={it.key}
                        entries={it.entries}
                        bare
                        live={it.key === liveToolsKey}
                        shell={stream.shell ?? undefined}
                      />
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
           * ⚠️ 首屏只有 60 条(见服务端 `MESSAGE_PAGE`)—— 实测这条链路的**上行只有
           * ~3 KB/s、往返 2~6 秒**,而 300 条的响应约 500KB,首屏就是三十几秒。
           * 所以**这个按钮不是锦上添花,是老消息唯一的入口**。
           *
           * 做成**按钮**而不是"滑到顶自动加载":后者会在你正往上翻的时候突然插进一大段
           * 内容把视野顶走,而手机上没有任何办法表达"我正在读的那一行"。
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
          /**
           * 往前面插内容时**把当前视野钉住** —— 不然刚加载完,你正在看的那一行会被
           * 新内容顶到屏幕下面去,像是"跳了一下"。
           */
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onScroll={onScroll}
          // 用户一动手,滚动位置就从"忽略"切成"算数"(见 userScrolledRef 的说明)
          onScrollBeginDrag={() => {
            userScrolledRef.current = true;
          }}
          scrollEventThrottle={16}
          // 关键:只在用户本来就贴着底时才自动跟随。
          // 原来这里无条件 scrollToEnd,于是流式输出时想上翻看历史会被一直拽回来。
          onContentSizeChange={() => {
            if (atBottomRef.current) listRef.current?.scrollToEnd({ animated: false });
          }}
        />
        {showJump ? (
          <Pressable onPress={() => scrollToBottom()} style={styles.jumpBtn} hitSlop={6}>
            <Ionicons name="arrow-down" size={16} color={theme.color.onAccent} />
          </Pressable>
        ) : null}
      </View>

      {stream.streaming ? (
        <View style={styles.streamingBox}>
          <Text style={styles.streamingText} selectable>
            {stream.streaming}
          </Text>
        </View>
      ) : null}

      {phase.kind !== "idle" ? (
        <View style={styles.phaseRow}>
          {working ? (
            <ActivityIndicator size={13} color={phaseColor} />
          ) : (
            <Ionicons
              name={phase.kind === "question" ? "help-circle-outline" : "lock-closed-outline"}
              size={12}
              color={phaseColor}
            />
          )}
          <Text style={[styles.phaseText, { color: phaseColor }]}>{phase.text}</Text>
        </View>
      ) : null}

      {/*
        提权请求(红卡)。排在审批前面 —— 它只等 5 分钟,而普通审批是 30 分钟。
        两张卡可以同时在:一件是"放行这次工具调用",一件是"给管理员权限",不是一回事。
      */}
      {stream.elevated ? (
        <ElevatedCard
          req={stream.elevated}
          onDecide={stream.respondElevated}
          // reqId 是 UUID(两种卡不会撞),所以只比它就知道"正在等回执的是不是这一张"
          submitting={stream.submitting?.reqId === stream.elevated.reqId}
        />
      ) : null}

      {stream.pending ? (
        questions ? (
          <QuestionCard
            questions={questions}
            onAnswer={(answers) => stream.respondApproval("allow", undefined, answers)}
            submitting={stream.submitting?.reqId === stream.pending?.reqId}
          />
        ) : (
          <ApprovalCard
            pending={stream.pending}
            onDecide={stream.respondApproval}
            submitting={stream.submitting?.reqId === stream.pending.reqId}
          />
        )
      ) : null}

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

      {/* 已选待发的图。横排缩略图而不是直接塞进输入框 —— 后者在 RN 里要算行内布局 */}
      {images.length > 0 ? (
        <View>
          {/* 档位是**每张**定的,所以标在每张下面;这里只说总量和怎么改 */}
          <Text style={styles.thumbTier}>
            点缩略图可改这一张的档位 · 共 {images.length} 张 · {pendingKb}KB
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
                {/* 这一张的档位 + 压完的**实际**尺寸 —— 模型认不认得出,靠这两行对账 */}
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
          // 键盘弹起时不要再补导航栏的高度 —— 它已经被键盘盖住了,不然输入框会浮在键盘上方一小截
          { paddingBottom: keyboardUp ? theme.space(2) : Math.max(insets.bottom, theme.space(3)) },
        ]}
      >
        <Pressable
          onPress={attach}
          disabled={picking}
          style={styles.attachBtn}
          hitSlop={6}
          accessibilityLabel="添加图片"
        >
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
          placeholder={
            waking ? "正在唤醒会话…" : stream.busy ? "继续补充说明…" : "说点什么,可加图或文件"
          }
          placeholderTextColor={theme.color.textFaint}
          multiline
          maxLength={8000}
        />
        {/* 打断挪到发送键旁边 —— 原来在右上角,和"把消息发出去"是两个方向的手势 */}
        {stream.busy ? (
          <Pressable onPress={stream.interrupt} style={styles.stopSquare} hitSlop={6}>
            <Ionicons name="square" size={16} color={theme.color.danger} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => void send()}
          disabled={!canSend}
          style={[styles.sendBtn, !canSend && styles.sendBtnOff]}
        >
          <Ionicons
            name="arrow-up"
            size={20}
            color={canSend ? theme.color.onAccent : theme.color.textFaint}
          />
        </Pressable>
      </View>

      {/* 会话设置。权限模式从原来单独占一行挪进来,以后的新设置也往这里加 */}
      <Sheet
        visible={showSettings}
        onClose={() => {
          setShowSettings(false);
          setConfirmEnd(false);
        }}
        title="会话设置"
      >
        <View style={styles.sheetBlock}>
          <Text style={styles.sheetLabel}>权限模式</Text>
          <ModePicker value={stream.mode} onChange={changeMode} />
          <Text style={styles.sheetHint}>{modeHint(stream.mode)}</Text>
        </View>

        {/*
          会话名。名字写在电脑上那个会话文件里(jsonl),所以电脑端也认、库重建也不丢 ——
          见 api.renameSession 与后端 /api/sessions/:id/title。
        */}
        <View style={styles.sheetBlock}>
          <Text style={styles.sheetLabel}>会话名称</Text>
          <Text style={styles.sheetHint}>当前:{live.title}</Text>
          <Btn
            label="改个名字"
            icon="create-outline"
            kind="ghost"
            full
            disabled={waking}
            onPress={() => {
              setShowSettings(false);
              setTitleDraft(live.title);
              setRenaming(true);
            }}
          />
        </View>

        {/*
          结束会话。放在这一屏而不是藏进设置页 —— 它是"这个会话"的动作,不是全局配置。
          ⚠️ 二次确认是必须的:它会掐掉正在跑的那一轮。
        */}
        <View style={styles.sheetBlock}>
          <Text style={styles.sheetLabel}>结束这个会话</Text>
          <Text style={styles.sheetHint}>
            让电脑上那个 claude 进程退出。改过环境变量、加过技能之后用它重新载入 ——
            聊天记录不会丢,下次进来照样接着聊。
          </Text>
          {confirmEnd ? (
            <>
              <Btn
                label={stream.busy ? "确认结束(会打断正在跑的一轮)" : "确认结束"}
                kind="danger"
                full
                loading={ending}
                onPress={() => void endSession()}
              />
              <Btn label="算了" kind="quiet" full onPress={() => setConfirmEnd(false)} />
            </>
          ) : (
            <Btn
              label="结束会话"
              icon="power-outline"
              kind="ghost"
              full
              disabled={waking}
              onPress={() => setConfirmEnd(true)}
            />
          )}
        </View>
      </Sheet>

      {/*
        改名。用一个单独的输入面板,不用 Alert —— Android 上没有 `Alert.prompt`
        那一套(那是 iOS 专属),而这里本来就有 Sheet 这个统一的面板组件。
      */}
      <Sheet
        visible={renaming}
        onClose={() => setRenaming(false)}
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
          disabled={!titleDraft.trim() || titleDraft.trim() === live.title}
          onPress={() => void saveTitle(titleDraft)}
        />
        {/*
          恢复默认名。⚠️ 这**不是**"取消":它会把那条自定义名从会话文件里抹掉,
          回落到 AI 起的名字(或第一句话)。所以文案要说清、而且只在真的改过名时出现。
        */}
        <Btn
          label="恢复默认名"
          kind="quiet"
          full
          onPress={() => void saveTitle("")}
        />
        <Btn label="取消" kind="quiet" full onPress={() => setRenaming(false)} />
      </Sheet>

      {/* 长按消息弹出来的复制菜单 */}
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

      {/* 本会话产出的文件。列表可能很长,给它自己的滚动区,别把 Sheet 撑爆 */}
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
                    setArtifactDetail(await api.artifact(a.id));
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    gap: theme.space(2),
  },
  // 题头没有展开功能,字号收一档好多塞几个字 —— 之前用 lg 时一行还没填满就省略号了
  title: { color: theme.color.text, fontSize: theme.font.size.md, fontWeight: theme.font.weight.semibold },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  sub: { color: theme.color.textFaint, fontSize: theme.font.size.xs },

  stopSquare: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.color.danger,
  },

  sheetBlock: { gap: theme.space(3) },
  /** 会话设置里每一项下面那行说明 */
  sheetHint: { color: theme.color.textFaint, fontSize: theme.font.size.xs, lineHeight: 18 },
  sheetLabel: {
    color: theme.color.textDim,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.bold,
    letterSpacing: 1.2,
  },

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
  headerBtns: { flexDirection: "row", alignItems: "center", gap: theme.space(1) },
  artifactScroll: { maxHeight: 360 },

  listWrap: { flex: 1 },
  listContent: { paddingTop: theme.space(2), paddingBottom: theme.space(4) },
  /** 「加载更早」那一行。居中、低调 —— 它是入口,但不该抢内容的注意力 */
  loadOlder: { alignItems: "center", paddingVertical: theme.space(4) },
  loadOlderText: { color: theme.color.accent, fontSize: theme.font.size.sm },

  /** 一轮 AI 回答的容器。用户消息仍然是自己一个气泡,只有回答这边需要合起来 */
  turnWrap: { paddingHorizontal: theme.space(3), marginBottom: theme.space(3) },
  turnBox: {
    backgroundColor: theme.color.assistantBubble,
    borderRadius: theme.radius.lg,
    padding: theme.space(3),
    gap: theme.space(2),
  },

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

  streamingBox: {
    paddingHorizontal: theme.gutter,
    paddingVertical: theme.space(2),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border,
  },
  streamingText: { color: theme.color.text, fontSize: theme.font.size.md, lineHeight: 24 },

  phaseRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.gutter,
    paddingBottom: theme.space(2),
  },
  phaseText: { fontSize: theme.font.size.xs },

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
  /** 改 108:缩略图下面要放一行"压完的像素尺寸" */
  thumbStrip: { maxHeight: 108 },
  thumbStripContent: {
    gap: theme.space(2),
    paddingHorizontal: theme.space(3),
    paddingTop: theme.space(2),
  },
  /** 下面那行尺寸文字要占位,所以这里不再钉死高度 */
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
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.color.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnOff: { backgroundColor: theme.color.surfaceAlt },
});
