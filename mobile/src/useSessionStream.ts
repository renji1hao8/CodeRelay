import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "./api";
import type { PickedImage } from "./imagePick";
import { alreadyHave, echoesExisting, makeLocalMessage, mergeHistory } from "./messageMerge";
import { parseQuestions } from "./shared";
import type { ChatBlock, ChatMessage, ClientFrame, PermissionDecision, PermissionMode, ServerFrame } from "./shared";
import { toolLabelOf } from "./theme";
import { clearEventNotifications } from "./native/notify";

/**
 * WS 断开后多久才认为"真的断了"。
 *
 * 切屏 / 息屏 / 切网络都会让 Android 掐掉 socket,而重连通常一两秒就成 ——
 * 立刻报「连接中断」只会制造噪音(使用者的原话:「反正几秒后就重连上了」)。
 * 超过这个时间还没接上,才是值得告诉他的事。
 *
 * 注意这和"阈值"是两回事:宽限期只决定**什么时候说**,不影响数据能不能拿到 ——
 * 真正让数据不受抖动影响的是 api.ts 那边的重试。
 */
const DISCONNECT_GRACE_MS = 5_000;

/**
 * 重连之后等"接入那一帧 `state`"最多多久。
 *
 * 它一到就能判定"补发够不够";够的话**不必重拉历史** —— 实测这条链路上行只有 ~3 KB/s,
 * 一页 44KB 要十几秒,而那一帧只有一百来字节。
 *
 * ⚠️ 给 8 秒是有依据的:这条链路的**往返就要 2~6 秒**(实测),而那一帧还排在回放之后。
 * 给短了会在那一帧还没到时就白拉一次 —— 反而比不优化更慢。
 */
const CATCHUP_WAIT_MS = 8_000;

/**
 * "看着还连着、其实已经死了"多久算死。
 *
 * 手机切走之后 Android 会把 App 的 JS 线程冻住,而 socket 的 TCP 状态可能既没断、
 * 也没收到 FIN —— 回来时 readyState 还是 OPEN,可什么都不会再来。这种连接不会触发
 * onclose,于是 App 永远不重连,页面就停在旧内容上(使用者的原话是"得退出去再进来")。
 * 所以按"多久没有任何帧"判:真跑着的时候不可能这么久没有帧 —— 连工具调用都有结果帧回来。
 */
const STALE_MS = 120_000;

export interface PendingApproval {
  reqId: string;
  tool: string;
  input: Record<string, unknown>;
  diff?: string;
}

/**
 * 一条**提权请求** —— 电脑上那个提权执行器想动手,等你批准。
 *
 * 它和 `PendingApproval` 是**两码事**(见 shared 的 `elevated_request` 帧):那条是
 * "这个会话里的一次工具调用要不要放行",这条是"给不给管理员权限"。所以界面上是
 * 单独一张**红卡**,两件事同时发生也各占一块,不挤在一张卡里。
 */
export interface PendingElevated {
  reqId: string;
  action: string;
  title: string;
  /** 具体要做什么:哪条命令、哪个证书。**是数据显示,不是指令** */
  detail: string;
  caller: string;
  reason: string;
}

/** 一次发出去、还没被服务端确认的消息。会话已经结束时用它把草稿还回输入框 */
interface SentDraft {
  text: string;
  images: PickedImage[];
  at: number;
}

interface SessionStreamState {
  connected: boolean;
  ccSessionId: string | null;
  messages: ChatMessage[];
  streaming: string;
  pending: PendingApproval | null;
  /**
   * 未决的**提权请求**(红卡)。和 `pending` 并存 —— 它不属于任何一次工具调用。
   */
  elevated: PendingElevated | null;
  /** 正在执行中的工具(工具调用 id → 名字)。用来在界面上显示"正在执行 X" */
  pendingTools: Record<string, string>;
  busy: boolean;
  lastResult: { subtype: string; costUsd?: number; durationMs?: number; tokens?: number } | null;
  error: string | null;
  /**
   * 权限模式。**以服务端为准**。
   *
   * 以前这里是纯本地 state(点一下就先改自己),而那一帧 `set_mode` 一旦没送出去
   * (socket 没开时 `send` 是空操作,不排队也不报错),界面就永久显示一个后端
   * 根本没采纳的模式。现在服务端每次接入都推一帧真值过来,本地只做跟随。
   */
  mode: PermissionMode;
  /**
   * Bash 工具用的那个 shell(init 帧报的,见 shared 的 protocol.ts)。
   * 报在命令卡片上答"这次是在哪个 shell 里跑的"。null = 还没收到。
   */
  shell: string | null;
  /**
   * CLI 报的"只在本机终端里才有意义"的斜杠命令(如 exit)。
   *
   * 手机上打这些命令不会得到任何结果 —— 它们是交互式的,在 headless 的流里要么卡住
   * 要么报错。**这份名单不猜**:SDK 的 init 帧里就有,而且它自己的注释写着
   * "Phone/remote UIs should hide these"。
   */
  terminalSlash: string[];
  /**
   * 正在**等服务端回执**的那一下点击(`approval_ack`)。
   *
   * 为什么要有它:回执原来是 fire-and-forget —— 点完就把卡片关了,而 `ws.send()`
   * 返回 true 只代表"交给了 socket";socket 随后死掉的话帧根本没到,电脑那边还挂着
   * 等超时。使用者的原话是「我点了、卡片也没了,但电脑那边像没收到」—— 卡片已经消失,
   * 他只能猜要不要再进去点一次,表现出来就是"要点好几次"。
   *
   * 现在点完进"提交中"(按钮转圈、禁用),**收到回执才关卡片**;等不到就退回可点状态
   * 并说明。宁可让人再点一次,也不要"看起来成功了其实没有"。
   */
  submitting: { kind: "permission" | "elevated"; reqId: string; at: number } | null;
  /**
   * 距离**最后一次有输出**过了多久(毫秒,服务端每 15 秒随 `state` 帧推来)。
   *
   * 用来分辨两种完全不同的处境:agent 在跑一个长时间不出声的东西(定时任务、几分钟
   * 不回话的工具调用)—— 那是**正常**的、不该去打断;还是它卡住了。光看 `busy`
   * 分不出来,两者都显示"正在思考"。
   */
  idleMs: number;
}

const INITIAL: SessionStreamState = {
  connected: false,
  ccSessionId: null,
  messages: [],
  streaming: "",
  pending: null,
  elevated: null,
  pendingTools: {},
  busy: false,
  lastResult: null,
  error: null,
  // 会被服务端接入时推来的 mode_changed 立刻覆盖,这里只是占位
  mode: "ask",
  shell: null,
  terminalSlash: [],
  submitting: null,
  idleMs: 0,
};

/**
 * 等服务端回执的保险时长。
 *
 * 6 秒:比一个来回(几十到几百毫秒)宽得多,又短到人不会以为"按键坏了"。
 * 超时**不代表失败** —— 帧可能只是晚了,所以卡片退回去还能再点。
 */
const ACK_TIMEOUT_MS = 6_000;

/** 末尾那行状态小字。长时间没输出时,用户得知道它是在想还是在干活 */
interface Phase {
  kind: "idle" | "thinking" | "outputting" | "tool" | "approval" | "question";
  text: string;
}

/**
 * "已经多久没出声了" —— 附在状态小字后面。
 *
 * 为什么需要:光说"正在思考"没法分辨两种处境 —— agent 在跑一个长时间不出声的东西
 * (定时任务、几分钟不回话的工具调用),和它卡住了。前者不该去打断,后者该。
 * 使用者 2026-09-21 问的正是这个:「怎么判断当前对话是不是还在输出」。
 *
 * 一分钟以内不显示(否则每轮都挂着个"(已静默 0 分钟)"似的噪音)。
 */
function silentSuffix(idleMs: number): string {
  const min = Math.floor(idleMs / 60_000);
  return min >= 1 ? `(已静默 ${min} 分钟)` : "";
}

function derivePhase(s: SessionStreamState): Phase {
  /**
   * 提权请求排在最前面:它只等 5 分钟(普通审批是 30 分钟),而且电脑那头有个脚本
   * 正卡在半路等着 —— 这一行小字得先说它。
   */
  if (s.elevated) return { kind: "approval", text: "等你批准提权" };
  if (s.pending) {
    // 提问和审批走同一条通道,靠 input 形状区分
    const isQuestion = parseQuestions(s.pending.input) !== null;
    return isQuestion
      ? { kind: "question", text: "等待你选择" }
      : { kind: "approval", text: "等待你批准" };
  }
  const tools = Object.values(s.pendingTools);
  if (tools.length > 0) {
    const label = toolLabelOf(tools[tools.length - 1] ?? "");
    const base = tools.length > 1 ? `正在${label}(另有 ${tools.length - 1} 项在跑)` : `正在${label}`;
    // ⚠️ 静默时长也要挂在这一支上 —— "跑一个长时间不出声的东西"在界面上**正是**
    //    一个挂着的工具调用(定时任务就是个 Bash),不挂在这儿就等于没做。
    return { kind: "tool", text: base + silentSuffix(s.idleMs) };
  }
  if (s.streaming) return { kind: "outputting", text: "正在输出" };
  if (s.busy) return { kind: "thinking", text: `正在思考${silentSuffix(s.idleMs)}` };
  return { kind: "idle", text: "" };
}

export function useSessionStream(
  api: Api,
  runId: string | null,
  seed?: ChatMessage[],
  initialBusy?: boolean,
  initialMode?: PermissionMode,
  /**
   * 这条流已经死了(runId 在后端不存在)时,重新 resume 拿到新 runId 后通知外面换掉。
   *
   * 不传就等于放弃自愈 —— 调用方必须传,理由见下面 revive 的说明。
   */
  onRunIdChange?: (runId: string) => void,
  /**
   * 「更早的一页」的游标 —— 打开会话时那次 `sessionDetail` 给的 `olderCursor`。
   *
   * ⚠️ 加在**末尾**是故意的:这六个位置参数都在用,插在中间会让调用点静默错位。
   * 什么时候该把它改成对象参数,见 `loadOlder` 的说明。
   */
  seedOlderCursor?: number | null,
) {
  const [state, setState] = useState<SessionStreamState>(INITIAL);
  /**
   * 往上翻。
   *
   * ⚠️ 首屏只有 `MESSAGE_PAGE`(60)条 —— 这是 2026-09-27 定的:实测这条链路的
   * **上行只有 ~3 KB/s、往返 2~6 秒**,而 300 条的响应约 500KB,首屏三十几秒。
   * 所以"往上翻"不是锦上添花,是**老消息唯一的入口**。
   */
  const [olderCursor, setOlderCursor] = useState<number | null>(seedOlderCursor ?? null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  // 用 ref 持有种子:它变了不该触发重连,只在 runId 变化时随初始状态一起用上
  const seedRef = useRef(seed);
  seedRef.current = seed;
  /** 最近一次 system/init 报上来的 CC 会话 id —— 重连后重拉历史要用它当 key */
  const ccIdRef = useRef<string | null>(null);
  // 同上:复用一个正在跑的会话时,进页面就该是忙的
  const busyRef = useRef(initialBusy === true);
  busyRef.current = initialBusy === true;
  // 进页面先按调用方给的模式显示,接上流之后由服务端推来的真值覆盖(见下面 onmessage)
  const modeRef = useRef<PermissionMode>(initialMode ?? "ask");
  modeRef.current = initialMode ?? "ask";
  // 应答审批时要拿到"当前这张卡",而回调里读不到最新的 state —— 镜像一份到 ref
  const pendingRef = useRef<PendingApproval | null>(null);
  pendingRef.current = state.pending;
  // 提权那张红卡同理(它是另一张卡,不能和审批共用一份 ref)
  const elevatedRef = useRef<PendingElevated | null>(null);
  elevatedRef.current = state.elevated;
  // 同理:看门狗与重新接入都要读最新的 state(闭包里那份是旧的)
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 最近一次收到帧的时刻 —— 看门狗用它判断"这条连接是不是已经死了" */
  const lastFrameAtRef = useRef(Date.now());
  /** 防止自愈重入(错误帧会连着来) */
  const resumingRef = useRef(false);
  /** "等服务端回执"那道保险的定时器(见 `armAckTimeout`) */
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 刚发出去、服务端还没确认的那条消息。
   *
   * ⚠️ 用途只有一个:后端的流已经结束了(`CcSession.send` 明确拒绝)时,把这条消息
   * **还给使用者**。以前它是石沉大海 —— 使用者的原话是「界面在但没回音,一直说正在
   * 思考,但退出去重新进来会发现我的输入没写进 jsonl」。转圈能修,打出去的一长段话
   * 丢了却找不回来。
   *
   * 一旦这一轮开始有回音(第一帧 assistant_delta / assistant_message / result)就清掉 ——
   * 那说明它已经安全到达,不能再被后面的错误帧翻出来塞回输入框。
   */
  const inflightRef = useRef<SentDraft | null>(null);
  /** 待还给使用者的草稿。ChatScreen 消费掉之后调 clearLostDraft */
  const [lostDraft, setLostDraft] = useState<SentDraft | null>(null);

  /**
   * 增量的"平滑器"。
   *
   * 为什么需要:**React 会把一批 setState 合成一次渲染**。切屏回来时积压的那些
   * `assistant_delta` 要么一次全到(服务端回放那一路),要么在 JS 线程解冻后一次全到 ——
   * 两种都是一屏字突然出现,而不是"流"出来。使用者的原话就是「直接更新中间的内容,
   * 画面不连续,而且会让用户感觉卡顿」。
   *
   * 所以先攒着,每 40ms 吐掉当前积压的六分之一(最少 4 字、最多 200 字)——
   * 看着就是连续输出,而且积压越多吐得越快(不会为了"平滑"让最后一句等半天)。
   * 收尾帧(assistant_message / result / error)会把攒下的立刻冲干净。
   */
  const deltaBufRef = useRef("");
  const deltaTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopDeltaTimer = useCallback(() => {
    if (deltaTimerRef.current) {
      clearInterval(deltaTimerRef.current);
      deltaTimerRef.current = null;
    }
  }, []);

  const flushDelta = useCallback(() => {
    const buf = deltaBufRef.current;
    if (!buf) {
      stopDeltaTimer();
      return;
    }
    const take = Math.min(buf.length, Math.max(4, Math.ceil(buf.length / 6)), 200);
    const chunk = buf.slice(0, take);
    deltaBufRef.current = buf.slice(take);
    setState((s2) => ({ ...s2, streaming: s2.streaming + chunk, busy: true }));
  }, [stopDeltaTimer]);

  /** 把攒下的一次性全吐出去(收尾帧之前调,免得最后一句迟迟不出来) */
  const flushDeltaNow = useCallback(() => {
    const buf = deltaBufRef.current;
    stopDeltaTimer();
    deltaBufRef.current = "";
    if (buf) setState((s2) => ({ ...s2, streaming: s2.streaming + buf, busy: true }));
  }, [stopDeltaTimer]);

  /**
   * 回放增量里"正在复述已有内容"的那一段缓冲(见下面 applyReplayFrame)。
   *
   * 只在处理回放帧时用;每遇到一条助手消息 / 一次工具结果就清空 —— 那是"一段复述"
   * 的自然边界,下一段得重新判。
   */
  const replayBufRef = useRef("");

  const pushDelta = useCallback(
    (text: string) => {
      deltaBufRef.current += text;
      if (!deltaTimerRef.current) deltaTimerRef.current = setInterval(flushDelta, 40);
    },
    [flushDelta],
  );

  useEffect(() => {
    if (!runId) {
      // 还没有 runId = 后端的 claude 进程正在起。这时**不要清空** ——
      // 把手头的历史先铺上,让人能读;进程就绪后 runId 到位,这个 effect 会再跑一遍,
      // 那时才真正接上流。见 SessionsScreen.openSession 的两段式打开。
      setState({ ...INITIAL, messages: seedRef.current ?? [], mode: modeRef.current });
      return;
    }

    // 续接一个历史会话时,流里只有新帧。不回灌上文的话,打开就是一片空白,
    // 用户看不到这个会话之前聊了什么。
    setState({
      ...INITIAL,
      messages: seedRef.current ?? [],
      busy: busyRef.current,
      mode: modeRef.current,
    });

    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    /** 本 runId 下成功接入过没有 —— 用来分辨"首次接入"和"断线后重连" */
    let everConnected = false;
    /**
     * 收到过的最后一帧编号 —— 重连时报到 URL 上(`?since=`),服务端据此**精确补**。
     * 有它才谈得上"重连不必重拉历史"。
     */
    let lastSeq: number | null = null;
    /** 接入那一帧 `state` 还没来 —— 到了再决定要不要重拉历史(见 onmessage) */
    let awaitingCatchup = false;
    let catchupTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * 重拉一次历史。
     *
     * 断线期间**所有帧都丢了** —— 它们发给了一个当时并不存在的订阅者,
     * 而帧不落任何地方。审批由服务端补发(见 routes/stream.ts),其余靠这个补齐;
     * 不补的话切屏回来对话看着"卡在半截",非退出重进不可。
     */
    const refillHistory = async () => {
      const id = ccIdRef.current;
      if (!id) return;
      try {
        const detail = await api.sessionDetail(id);
        if (closed) return;
        setState((s) => ({ ...s, messages: mergeHistory(s.messages, detail.messages) }));
      } catch {
        // 补不上就算了 —— 下次重连还会再试,这里弹红字只会制造噪音
      }
    };

    /**
     * 这条流已经死了(runId 在后端不存在)时,重新 resume 一条新的。
     *
     * ⚠️ 为什么必须有:后端会回收**没人看着**的会话(空闲 30 分钟),手机切走正好满足
     * 这个条件 —— 回来时那个 runId 早没了,服务端回一帧 `recoverable: false` 就关掉。
     * 原来 App 只会**一直重连同一具尸体**,页面于是永远停在旧内容上,使用者只能退出去
     * 再进来(他的原话:「有时候切屏回来会卡页面不更新,需要自己退出去再进来」)。
     *
     * 拿到新 runId 后交给外面(它持有 LiveChat),这个 effect 会因为 runId 变化重跑一遍,
     * 于是重新接入、回放错过的帧。
     */
    const revive = async () => {
      const id = ccIdRef.current;
      if (!id || !onRunIdChange || resumingRef.current || closed) return;
      resumingRef.current = true;
      try {
        // 把当前列表交出去当下一次的种子 —— 不然 runId 一变,那个 effect 会用"打开会话
        // 那一刻"的旧 seed 重置列表,中间这些消息会先消失一下再回来
        seedRef.current = stateRef.current.messages;
        const live = await api.resumeSession(id, null, modeRef.current);
        if (!closed) onRunIdChange(live.runId);
      } catch {
        // 起不来就算了:关掉的那条连接会让重连继续跑,界面上也会有提示
      } finally {
        resumingRef.current = false;
      }
    };

    /**
     * 看门狗:忙、却长时间一帧都没有 → 主动断掉走重连。
     *
     * 判据只看"忙"的时候:空闲的会话本来就收不到帧,拿它去判会把好好的连接掐掉。
     */
    const liveness = setInterval(() => {
      if (closed) return;
      if (!stateRef.current.busy) return;
      if (Date.now() - lastFrameAtRef.current < STALE_MS) return;
      lastFrameAtRef.current = Date.now(); // 别连环触发
      wsRef.current?.close();
    }, 15_000);

    /**
     * 一帧**回放**。
     *
     * 与实时帧的唯一区别:它的内容**可能已经在你手上了** —— 后端补的是"你不在的那
     * 一小段",而那段输出 CLI 早写进 jsonl、也早被索引进打开这个会话时拉的那份历史里。
     * 原样渲染就会让同一段话出现两遍(使用者报的「agent 的话重复两遍甚至多遍;退出重进
     * 解决不了」)。
     *
     * 所以先按指纹认亲:认上了就当没这帧。
     * ⚠️ 认亲只对**回放**做。实时帧是一段新内容,哪怕逐字与前面某条一模一样(模型真的
     * 重复说话),那也是两条独立的消息,不能合并。
     */
    const applyReplayFrame = (frame: ServerFrame) => {
      if (frame.t === "assistant_delta") {
        const buf = replayBufRef.current + frame.text;
        // 还在复述已有的内容 → 咽着不画。等它岔开(也就是出现新内容)再整段放出去。
        // 前面重合的那几个字会跟着一起放 —— 有限的一点点重复,不值得为它加一层
        // "最长公共前缀"的记账。
        if (echoesExisting(stateRef.current.messages, "assistant", buf)) {
          replayBufRef.current = buf;
          return;
        }
        replayBufRef.current = "";
        pushDelta(buf);
        return;
      }
      // 一条助手消息 / 一次工具结果 = 一段复述到此为止,下一段重新判
      if (frame.t === "assistant_message" || frame.t === "tool_result") replayBufRef.current = "";
      if (frame.t === "assistant_message" || frame.t === "result" || frame.t === "error") {
        flushDeltaNow();
      }
      setState((s) => applyFrame(s, frame, true));
    };

    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(api.streamUrl(runId, lastSeq));
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        // 接上了就撤掉宽限期那颗定时器 —— 短抖动不该留下任何痕迹
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
        setState((s) => ({ ...s, connected: true, error: null }));
      };

      ws.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(event.data)) as ServerFrame;
        } catch {
          return;
        }
        lastFrameAtRef.current = Date.now();
        // 回放帧单独走(见 applyReplayFrame)。放在最前面是有意的:**下面那些都是
        // "活着的那条流"的反应**(把刚发出去那条草稿销账、流死了就自愈)—— 回放的帧
        // 是旧内容,不该触发它们。
        if (frame.t === "replay") {
          applyReplayFrame(frame.frame);
          return;
        }
        if (frame.t === "error" && frame.recoverable === false) {
          // 这条流在后端已经不存在了(会话被回收 / 后端重启过 / 子进程已退出)→ 换一条,别原地重连
          //
          // ⚠️ 顺带把"刚发出去、服务端还没确认"的那条**还给使用者**。这条错误最常见的
          // 来路正是"发消息时那条流其实已经结束了":后端收下了帧、但 `CcSession.send`
          // 拒绝接收,于是界面一直转圈、而这行字永远进不了 jsonl(见 inflightRef 的说明)。
          const lost = inflightRef.current;
          if (lost && Date.now() - lost.at < 5 * 60_000) setLostDraft(lost);
          inflightRef.current = null;
          void revive();
          return;
        }
        // 这一轮有回音了 = 刚发出去那条已经安全到达,把兜底清掉 ——
        // 否则后面任何一次"会话被回收"都会把一段早就聊完的话翻出来塞回输入框
        if (
          frame.t === "assistant_delta" ||
          frame.t === "assistant_message" ||
          frame.t === "result"
        ) {
          inflightRef.current = null;
        }
        // 增量走平滑器,不进 applyFrame —— 那里是"立刻加进 streaming",成批到达就成了一次跳变
        if (frame.t === "assistant_delta") {
          pushDelta(frame.text);
          return;
        }
        // 收尾帧之前先把攒下的吐干净,否则最后一句会晚一拍才出现
        if (frame.t === "assistant_message" || frame.t === "result" || frame.t === "error") {
          flushDeltaNow();
        }
        // 回放那段"复述判据"到此为止(`state` 是回放结束的信号,后两者是一条消息的边界)。
        // 不清的话,回放尾巴上那半句会跟后面实时来的增量接在一起,判据就再也对不上了。
        if (frame.t === "state" || frame.t === "assistant_message" || frame.t === "tool_result") {
          replayBufRef.current = "";
        }
        // 帧编号 —— 下次重连报到 URL 上,服务端据此**精确补**(见 api.streamUrl 的 since)
        if (frame.t === "state" && typeof frame.seq === "number") lastSeq = frame.seq;
        if (frame.t === "system") {
          ccIdRef.current = frame.sessionId;
          // 服务端每次接入都会推 init,所以这一帧到得比什么都早 —— 拿它当"接好了"的信号
          if (everConnected) {
            /**
             * ⚠️ 重连**不立刻重拉历史** —— 等接入那一帧 `state` 的 `catchupComplete` 说话
             * (它排在回放之后)。说"齐了"就不必花十几秒去拉那 44KB。
             * **但必须有兜底**:那一帧要是没来(老后端、或它自己丢了),到点仍旧重拉。
             */
            awaitingCatchup = true;
            if (catchupTimer) clearTimeout(catchupTimer);
            catchupTimer = setTimeout(() => {
              if (!awaitingCatchup) return;
              awaitingCatchup = false;
              void refillHistory();
            }, CATCHUP_WAIT_MS);
          }
          everConnected = true;
        }
        /**
         * 接入那一帧 `state` 到了 → **判定**。
         *
         * 只看接入后的**第一帧**:`state` 每 15 秒还有一次心跳,而心跳**不带**
         * `catchupComplete` —— 拿心跳判定会把"补发齐了"误判成"不齐",白拉一次。
         */
        if (frame.t === "state" && awaitingCatchup) {
          awaitingCatchup = false;
          if (catchupTimer) {
            clearTimeout(catchupTimer);
            catchupTimer = null;
          }
          // ⚠️ 缺字段(老后端)按"不齐"处理 = 照旧重拉。**安全的默认在这边**:
          // 猜成"齐了"而其实缺一段,是坑 40 那种最难查的形状。
          if (frame.catchupComplete !== true) void refillHistory();
        }
        setState((s) => applyFrame(s, frame));
      };

      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (closed) return;
        // ⚠️ 这里**不立刻报错**。切屏、息屏、切网络都会让 Android 掐掉 socket,
        // 而重连通常只要一两秒 —— 一关就弹「连接中断」,用户看到的是
        // "刚切出去回来就说我断了",再过两秒它又自己好了,纯属噪音。
        // 所以给一段宽限期:超过它还没接上,才认为是真的断了。
        if (!graceTimer) {
          graceTimer = setTimeout(() => {
            graceTimer = null;
            setState((s) => (s.connected ? s : { ...s, error: "连不上电脑,正在重试…" }));
          }, DISCONNECT_GRACE_MS);
        }
        // 自动重连,退避到最多 10 秒
        retryRef.current += 1;
        const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
        retryTimer = setTimeout(connect, delay);
      };

      // onerror 后面紧接着一定会来一个 onclose,报错统一交给上面那段宽限期处理。
      // 在这里再设一次,只会让"刚切出去"也闪一下红字 —— 那正是要消掉的噪音。
      ws.onerror = () => {};
    };

    connect();

    return () => {
      closed = true;
      clearInterval(liveness);
      stopDeltaTimer();
      deltaBufRef.current = "";
      if (retryTimer) clearTimeout(retryTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (catchupTimer) clearTimeout(catchupTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [api, runId]);

  /** 发一帧。**返回有没有真发出去** —— socket 没开时这里是空操作,不排队也不报错 */
  const send = useCallback((frame: ClientFrame): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }, []);

  /**
   * 发一条消息。**返回有没有真发出去** —— 发不出去时不许"假装成功"。
   *
   * ⚠️ 原来这里是先画回显、再 `send`,而 `send` 在 socket 没开时是**空操作**:
   * 界面上出现了一条消息、气泡也在抖"正在思考",可它永远到不了电脑。使用者的原话:
   * 「明明已经停了,但我这里还显示正在思考并且我的新输入会被阻断」——
   * 一半是 `busy` 没被纠正(见 state 帧),另一半就是这个:消息根本没出去。
   */
  const sendUserMessage = useCallback(
    (text: string, images: PickedImage[] = []): boolean => {
      const blocks: ChatBlock[] = images.map((img) => ({
        type: "image",
        mediaType: img.mediaType,
        // 本地回显用的是**手机自己的** URI —— 这一刻服务端还没拿到这张图,
        // 自然没有它的路径。历史回放时同一张图会带着真正的服务端路径回来,
        // 两条路互不冲突(设备 URI 与电脑路径不可能撞车)。
        path: img.uri,
        size: img.size,
      }));
      if (text.trim()) blocks.push({ type: "text", text });

      if (
        !send({
          t: "user_message",
          text,
          // 只把字节送出去,本地 URI 是手机自己的事,不该占帧
          images: images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
        })
      ) {
        // 没送出去就别画回显、别置忙 —— 让调用方把草稿还回去并说清原因
        return false;
      }

      setState((s) => ({
        ...s,
        messages: [...s.messages, makeLocalMessage("user", blocks)],
        busy: true,
      }));
      // 记住这一条,等后端的确认(见 inflightRef 的说明)
      inflightRef.current = { text, images, at: Date.now() };
      return true;
    },
    [send],
  );

  /**
   * 给"等服务端回执"上一道保险(时长与理由见 `ACK_TIMEOUT_MS`)。
   *
   * 收到回执时由 reducer 清掉 `submitting`;这里那颗定时器那时就成了空转(它开头会核对
   * reqId 还是不是当前那一条),所以不必去 `clearTimeout` 追着撤。
   */
  const armAckTimeout = useCallback((reqId: string, kind: "permission" | "elevated") => {
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    ackTimerRef.current = setTimeout(() => {
      ackTimerRef.current = null;
      setState((s) =>
        s.submitting?.reqId === reqId
          ? {
              ...s,
              submitting: null,
              error: "没收到电脑的确认 —— 连接可能刚断过,等它重连后再点一次",
            }
          : s,
      );
    }, ACK_TIMEOUT_MS);
  }, []);

  const respondApproval = useCallback(
    (decision: PermissionDecision, reason?: string, answers?: Record<string, string>) => {
      const req = pendingRef.current;
      if (!req) return;

      /**
       * ⚠️ **没送出去就别关卡片**。
       *
       * 原来这里无视 `send()` 的返回值、无条件把 pending 清掉 —— 于是在断开的那一瞬
       * (切屏、隧道抖一下,正好落在 5 秒宽限期里)点提交,表现是:卡片消失、电脑那边
       * 什么都没收到、也没有任何提示,只能等超时被拒。使用者的原话就是
       * 「我点了而且审批界面也关闭了,但是 ask 一直没返回」。
       *
       * 这和设置页的权限模式是同一类毛病(见 setMode):`send` 在 socket 没开时是空操作,
       * 不排队也不报错,而界面自己先当真了。区别是审批更贵 —— 它会把一轮对话挂到超时。
       *
       * 卡片留着是有用的:服务端每次接入都会按 `listPending()` 把未决审批补发一遍,
       * 所以重连之后这张卡还会在,再点一次就成了。
       */
      if (!send({ t: "permission_response", reqId: req.reqId, decision, reason, answers })) {
        setState((s) => ({ ...s, error: "连接已断开,这条审批没送到电脑上;等它重连后再点一次" }));
        return;
      }
      /**
       * ⚠️ **发出去了也不等于电脑收到了** —— 所以这里**不关卡片**。
       *
       * `send` 返回 true 只代表"交给了 socket",它随后死掉帧就没了,而原来这一刻
       * 卡片已经关了:使用者看到的是"点完卡片消失、电脑那边像没收到",只能等超时。
       * 现在进"提交中",由服务端那帧 `approval_ack` 来关(见 applyFrame 的对应分支)。
       */
      armAckTimeout(req.reqId, "permission");
      setState((s) => ({
        ...s,
        submitting: { kind: "permission", reqId: req.reqId, at: Date.now() },
      }));
      // 通知栏里那条提醒先收掉:人已经在卡片上做了决定,不必再提醒一次
      void clearEventNotifications("approval");
    },
    [send, armAckTimeout],
  );

  /**
   * 回答一条**提权请求**(红卡)。
   *
   * ⚠️ 和审批一样:**没送出去就别关卡片** —— 关掉之后卡片消失、电脑那头什么都没收到,
   * 只能干等 5 分钟超时被拒。而提权这张更要紧:它被误判的代价是"给管理员权限",
   * 所以宁可留着让他重连之后再点一次。
   *
   * ⚠️ 已知的小缺口(单设备用不到):如果是**另一台设备**先点了,这一台的卡片不会自动
   * 消失 —— 点上之后服务端会回一句"这条提权请求已经被处理过了",照着看就明白了。
   */
  const respondElevated = useCallback(
    (decision: "approve" | "deny") => {
      const req = elevatedRef.current;
      if (!req) return;
      if (!send({ t: "elevated_response", reqId: req.reqId, decision })) {
        setState((s) => ({ ...s, error: "连接已断开,这条决定没送到电脑上;等它重连后再点一次" }));
        return;
      }
      // 和审批一样:发出去了**不等于**收到了 —— 进"提交中",由 `approval_ack` 关卡片
      armAckTimeout(req.reqId, "elevated");
      setState((s) => ({
        ...s,
        submitting: { kind: "elevated", reqId: req.reqId, at: Date.now() },
      }));
      // 通知栏里那条"有人要用管理员权限"先收掉:决定已经做了,不必再提醒一次
      void clearEventNotifications("approval");
    },
    [send, armAckTimeout],
  );

  /**
   * 打断正在跑的这一轮。
   *
   * ⚠️ 这里是**唯一**还在吞掉 `send` 返回值的地方(`respondApproval` / `respondElevated`
   * / `setMode` 都已经改成"发不出去就明说")。后果是:socket 断着的时候按暂停键,
   * 界面**毫无反应** —— 而 `busy` 依然是 true、暂停键还在,人只会以为这个键坏了,
   * 于是一遍遍按。使用者 2026-09-21 报的「暂停接口」那条里就有这一项。
   *
   * 返回有没有发出去,给调用方决定要不要说点什么(现在只用来提示失败)。
   */
  const interrupt = useCallback((): boolean => {
    if (!send({ t: "interrupt" })) {
      setState((s) => ({ ...s, error: "连接已断开,这一下打断没送到电脑上;等它重连后再按" }));
      return false;
    }
    return true;
  }, [send]);
  /** 草稿已经还给 ChatScreen 了,把这份快照清掉,免得 effect 反复触发 */
  const clearLostDraft = useCallback(() => setLostDraft(null), []);

  /**
   * 改权限模式。
   *
   * ⚠️ 这里**故意不乐观改本地 state**。本地那份由服务端的 `mode_changed` 推回来
   * (接入时必推一帧,改成功后也会回一帧),以它为准 —— 否则这一帧一旦没送出去,
   * 界面就会显示一个后端没采纳的模式,而且永远不会自愈。发不出去就明说。
   */
  const setMode = useCallback(
    (mode: PermissionMode) => {
      if (!send({ t: "set_mode", mode })) {
        setState((s) => ({ ...s, error: "连接已断开,权限模式没改上" }));
      }
    },
    [send],
  );

  /**
   * 往上翻一页。
   *
   * ⚠️ **前置而不是替换** —— 老消息在列表头上。`refillHistory` 只动尾巴(见 `mergeReseed`),
   * 所以这里翻出来的不会被它冲掉。
   *
   * 游标是**排他**的(服务端走 `id < beforeId`),所以正常不会重叠;这里再兜一道 uuid
   * 去重,是为了游标语义万一将来变了也不会凭空多出两条一样的气泡。
   */
  const loadOlder = useCallback(async () => {
    const ccId = ccIdRef.current;
    if (olderCursor === null || loadingOlder || !ccId) return;
    setLoadingOlder(true);
    try {
      const page = await api.sessionDetail(ccId, olderCursor);
      setState((s) => {
        const have = new Set(s.messages.map((m) => m.uuid).filter((u): u is string => !!u));
        const fresh = page.messages.filter((m) => !m.uuid || !have.has(m.uuid));
        return { ...s, messages: [...fresh, ...s.messages] };
      });
      setOlderCursor(page.olderCursor);
    } catch {
      // 拉不动就保持原样:按钮还在,再点一次就行。**不弹错误** ——
      // 这一下失败不影响正在看的内容
    } finally {
      setLoadingOlder(false);
    }
  }, [api, olderCursor, loadingOlder]);

  return {
    ...state,
    phase: derivePhase(state),
    lostDraft,
    sendUserMessage,
    respondApproval,
    respondElevated,
    interrupt,
    setMode,
    clearLostDraft,
    olderCursor,
    loadingOlder,
    loadOlder,
  };
}

/**
 * 把一帧并进状态。
 *
 * `replayed` = 这帧是**重连时补发的**(见 protocol.ts 的 `replay` 帧)。只影响一件事:
 * 消息类帧要不要先按指纹认亲 —— 回放的内容可能已经在列表里了,而实时帧不会。
 */
function applyFrame(
  state: SessionStreamState,
  frame: ServerFrame,
  replayed = false,
): SessionStreamState {
  switch (frame.t) {
    case "replay":
      // 正常走不到这儿(onmessage 会先把它拆开,好让"复述判据"那条路拿到增量)。
      // 留着是为了这个 switch 对帧的覆盖是完整的。
      return applyFrame(state, frame.frame, true);

    case "system":
      return {
        ...state,
        ccSessionId: frame.sessionId,
        connected: true,
        // ⚠️ 用 `?? 旧值` 而不是 `?? 默认`:服务端补发 init 帧时会带齐这两样,但
        // **老后端不带**(协议里它们是可选字段)—— 别让一次重连把已经知道的事清空
        shell: frame.shell ?? state.shell,
        terminalSlash: frame.terminalSlashCommands ?? state.terminalSlash,
      };

    case "assistant_delta":
      // ⚠️ 这条路现在**不会**被走:增量在 onmessage 里就交给平滑器了(见 pushDelta)。
      // 留着是为了 applyFrame 对帧的覆盖是完整的 —— 谁要是绕过平滑器直接调它,行为仍是对的。
      return { ...state, streaming: state.streaming + frame.text, busy: true };

    case "assistant_message": {
      // 记下这一批发起了哪些工具 —— tool_result 回来之前,它们就是"正在执行"的那几项
      const pendingTools = { ...state.pendingTools };
      for (const b of frame.blocks) {
        if (b.type === "tool_use") pendingTools[b.id] = b.name;
      }
      /**
       * ⚠️ **回放来的、而且列表里已经有同一条** → 什么都不加,只把流式缓冲清掉。
       *
       * 这就是「agent 的话重复两遍」的直接病根:这条内容在打开会话时拉的历史里
       * 已经有了,回放又送来一份,追加就变成两个气泡。而这两个气泡**清不掉** ——
       * 补历史那套认亲只认"本地回显被真身顶掉",对"真身 + 回放的副本"无能为力,
       * 所以退出重进也照样在(重进又补一遍)。
       *
       * 认上之后**保留原来那条**(它在历史里,带真 uuid,而且可能还多带 thinking 块)。
       */
      if (replayed && alreadyHave(state.messages, "assistant", frame.blocks)) {
        return { ...state, streaming: "", pendingTools };
      }
      return {
        ...state,
        messages: [...state.messages, makeLocalMessage("assistant", frame.blocks)],
        streaming: "",
        pendingTools,
      };
    }

    case "tool_result": {
      const pendingTools = { ...state.pendingTools };
      delete pendingTools[frame.id];
      // 与历史回放的形状保持一致:工具结果作为一条 user 消息里的 tool_result 块
      const block: ChatBlock = { type: "tool_result", toolUseId: frame.id, text: frame.content, isError: frame.isError };
      // 回放 + 已经有一次同样的结果(工具调用 id 全局唯一,这条判据不会误伤)
      if (replayed && alreadyHave(state.messages, "user", [block])) {
        return { ...state, pendingTools };
      }
      return {
        ...state,
        messages: [...state.messages, makeLocalMessage("user", [block])],
        pendingTools,
      };
    }

    case "permission_request":
      return {
        ...state,
        pending: { reqId: frame.reqId, tool: frame.tool, input: (frame.input ?? {}) as Record<string, unknown>, diff: frame.diff },
        busy: true,
      };

    /**
     * 提权请求(红卡)。
     *
     * 和审批一样是**状态**:后端在手机每次接入时按未决列表补发一遍(见 routes/stream.ts),
     * 所以重连之后卡还在原地等人点 —— 它只等 5 分钟,这点尤其要紧。
     */
    case "elevated_request":
      return {
        ...state,
        elevated: {
          reqId: frame.reqId,
          action: frame.action,
          title: frame.title,
          detail: frame.detail,
          caller: frame.caller,
          reason: frame.reason,
        },
      };

    case "state":
      /**
       * 服务端接入时推的**真值**(见 protocol.ts 的说明),也是每 15 秒一次的心跳。
       *
       * 覆盖本地推测出来的忙/闲:切屏期间那一轮结束时 `result` 帧没人接,`busy` 会一直
       * 卡在 true —— 界面显示"正在思考"、新的东西看起来发不出去。每次接入对齐一次。
       *
       * `idleMs` 一并收下("已静默 N 分钟"),见 `derivePhase`。
       */
      return {
        ...state,
        busy: frame.busy,
        // 老后端不发这个字段(收到 undefined 时保留原值,别把它拍成 0)
        idleMs: frame.idleMs ?? state.idleMs,
        lastResult:
          frame.tokens !== undefined
            ? { ...(state.lastResult ?? { subtype: "success" }), tokens: frame.tokens }
            : state.lastResult,
      };

    case "approval_ack": {
      /**
       * 服务端收到了那一下点击 —— **这是唯一能关卡片的信号**。
       *
       * 点完先进"提交中"、收到这一帧才关(理由见 `SessionStreamState.submitting`)。
       * `result !== "ok"` 时服务端会给一句说法(`message`):超时和"已经点过"含义
       * 完全相反,措辞由服务端给、这里照显示,免得两边各写一份、各自漂移。
       */
      const submitting = state.submitting?.reqId === frame.reqId ? null : state.submitting;
      if (frame.kind === "permission") {
        return {
          ...state,
          submitting,
          pending: state.pending?.reqId === frame.reqId ? null : state.pending,
          error: frame.message ?? state.error,
        };
      }
      return {
        ...state,
        submitting,
        elevated: state.elevated?.reqId === frame.reqId ? null : state.elevated,
        error: frame.message ?? state.error,
      };
    }

    case "mode_changed":
      // 服务端推来的真值 —— 包括**每次接入时补的那一帧**(见 server 的 routes/stream.ts)。
      // 原来这里是 `return state`,把确认整个丢掉,于是界面只信自己那份本地猜测。
      return { ...state, mode: frame.mode };

    case "result":
      return {
        ...state,
        busy: false,
        streaming: "",
        pending: null,
        pendingTools: {},
        lastResult: { subtype: frame.subtype, costUsd: frame.costUsd, durationMs: frame.durationMs, tokens: frame.tokens },
      };

    case "error":
      return { ...state, error: frame.message, busy: false };

    case "upstream":
      return state;

    default:
      return state;
  }
}
