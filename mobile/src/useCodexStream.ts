import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "./api";
import {
  applyChatFrame,
  dropApproval,
  emptyChatState,
  mergeReseed,
  prependOlder,
  type CodexChatState,
} from "./codexChat";
import type {
  ChatBlock,
  ChatMessage,
  ClientFrame,
  CodexThreadSummary,
  PermissionDecision,
  ServerFrame,
} from "./shared";

/**
 * Codex 会话那条 WebSocket —— 比 `useSessionStream` 窄得多。
 *
 * ## 为什么可以窄
 *
 * Claude 那边要维护**增量平滑器**与**回放认亲**,是因为它的输出是"帧日志按节奏回放"
 * 出来的、和 App 手上的历史**两份来源重叠**(坑 40)。Codex 这边简单:历史**随时能重读**,
 * 所以重连就是重读一遍 —— 没有回放,也就没有认亲问题。
 *
 * ## 它自己拉历史
 *
 * 历史不进这条流(可能很长),所以这里在接上之前先 `GET /api/codex/threads/:id` 拿一份。
 * 重连时**重读 + mergeReseed**,而不是整份替换 —— 后者会把刚发出去、服务端还没记下的
 * 那句抹掉(与坑 40 同源,`mergeReseed` 就是为它写的)。
 *
 * ## 「加载更早」
 *
 * 与 Claude 那边同一个做法,但游标是**不透明字符串**(Codex 自己的分页态)。
 * ⚠️ 翻过页之后,重连时**不要再把游标重置回第一页的** —— 否则那个按钮会去重下一份
 * 已经有的内容(看着像"点了没反应")。见 `pagedRef`。
 */

/** 断了多久才认为"真断了"。切屏、息屏都会让 Android 掐掉 socket,一关就报错是噪音 */
const DISCONNECT_GRACE_MS = 5_000;

/** 要发给 Codex 的一张图 */
export interface CodexOutgoingImage {
  /** **电脑上**的路径 —— 先 `api.attach` 传上去拿到的 */
  path: string;
  /** 手机本地 URI。**只用于本地回显** —— 这一刻服务端还没拿这张图,自然没有它的路径 */
  localUri: string;
  mediaType: string;
  size: number;
}

export interface CodexStream extends CodexChatState {
  connected: boolean;
  /** 历史还在拉(首次)。界面据此显示"正在加载"而不是"空会话" */
  loading: boolean;
  /** 还有更早的内容没加载(就是"加载更早"那个按钮显不显示) */
  truncated: boolean;
  /** 加载更早的游标。`null` = 到头了 */
  olderCursor: string | null;
  loadingOlder: boolean;
  /** 往上翻一页 */
  loadOlder: () => Promise<void>;
  /**
   * 拉回来的那条会话本身(名字、目录…)。
   *
   * ⚠️ 从通知深链进来时,调用方手上**只有 id**(它不知道名字,而多打一次接口拿它
   * 会把整份历史一起拉回来)—— 所以名字在这里补上,标题等它到了再显示。
   */
  thread: CodexThreadSummary | null;
  /**
   * 发一句话(可带图)。**返回 false = 没发出去**(连接断着)。
   *
   * ⚠️ 调用方**必须**看这个返回值并把草稿还回输入框 —— 原来是 `void`,于是
   * "socket 没开时 `post` 空转 + 界面已经把草稿清空"合起来等于**静默丢消息**:
   * 使用者以为发出去了,而服务端一个字都没收到。与 Claude 那边
   * `sendUserMessage` 的语义对齐(见 `ChatScreen.tsx` 里那句"连接已断开,这条没发出去")。
   *
   * ⚠️ 图要**先上传**(`api.attach`)再调这里 —— Codex 收的是电脑上的**路径**,
   * 不是字节。传上来的那张图同时用于本地回显(`localUri` 是手机自己的,两条互不冲突)。
   */
  send: (text: string, images?: CodexOutgoingImage[]) => boolean;
  interrupt: () => void;
  /** 回答一条审批 */
  answer: (reqId: string, decision: PermissionDecision) => void;
}

export function useCodexStream(api: Api, threadId: string | null, seed?: ChatMessage[]): CodexStream {
  /**
   * 初值可以带几条**手工铺的消息** —— 新建会话时用它。
   *
   * 第一句话是随创建请求发出去的(不走聊天页的输入框),而服务端那条流只推助手侧,
   * 所以不铺的话进去只看到 Codex 的回答、看不到自己刚打的那句。身份是 `local-N`,
   * 重连补历史时 `mergeReseed` 会拿真身认亲。
   */
  const [state, setState] = useState<CodexChatState>(() =>
    seed && seed.length > 0 ? { ...emptyChatState, messages: seed } : emptyChatState,
  );
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [thread, setThread] = useState<CodexThreadSummary | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  /** 给 WS 回调读的最新状态(它们闭包在建立连接那一刻,读 state 会读到旧的) */
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 用户已经往上翻过页了 —— 重连时别再把游标重置回第一页(见文件头) */
  const pagedRef = useRef(false);

  const apply = useCallback((frame: ServerFrame) => {
    setState((s) => applyChatFrame(s, frame));
  }, []);

  useEffect(() => {
    if (!threadId) return;

    let closed = false;
    let everConnected = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    /** 拉一份历史。重连时也走它 —— 拿到的是权威版本 */
    const refill = async () => {
      try {
        const detail = await api.codexThread(threadId);
        // 会话自己的名字/目录也顺手拿上 —— 从通知深链进来时调用方手上只有 id
        setThread(detail.thread);
        // ⚠️ 翻过页就别再重置游标了,否则"加载更早"会去重下一份已经有的内容
        if (!pagedRef.current) setOlderCursor(detail.olderCursor);
        setState((s) => ({
          ...s,
          // ⚠️ merge 而不是整份替换 —— 见文件头
          messages: mergeReseed(s.messages, detail.messages),
        }));
      } catch {
        // 拉不动就先不算数 —— 那条流接上之后还会有帧,而且下一次重连会再试
      }
    };

    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(api.codexStreamUrl(threadId));
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        setConnected(true);
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
        // 重连上来的话再读一遍历史 —— 断开期间发生的事只有服务端知道
        if (everConnected) void refill();
        everConnected = true;
        setLoading(false);
      };

      ws.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(event.data)) as ServerFrame;
        } catch {
          return;
        }
        apply(frame);
      };

      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        // ⚠️ 不立刻报错:切屏回来重连通常只要一两秒,一关就弹"连接中断"纯属噪音
        if (!graceTimer) {
          graceTimer = setTimeout(() => {
            graceTimer = null;
            setState((s) => (s.error ? s : { ...s, error: "连不上电脑,正在重试…" }));
          }, DISCONNECT_GRACE_MS);
        }
        retryRef.current += 1;
        const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
        retryTimer = setTimeout(connect, delay);
      };

      // onerror 后面一定会来 onclose,报错统一交给宽限期那段
      ws.onerror = () => {};
    };

    void (async () => {
      await refill();
      if (!closed) setLoading(false);
    })();
    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (graceTimer) clearTimeout(graceTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [api, threadId, apply]);

  /**
   * 往上翻一页。
   *
   * ⚠️ 与 Claude 那边一样**不弹错误**:拉不动就保持原样,按钮还在,再点一次就行。
   * 这里弹红字只会在链路抖动时制造噪音。
   */
  const loadOlder = useCallback(async () => {
    const cursor = olderCursor;
    if (!threadId || !cursor || loadingOlder) return;
    setLoadingOlder(true);
    pagedRef.current = true;
    try {
      const page = await api.codexThread(threadId, cursor);
      setState((s) => ({ ...s, messages: prependOlder(s.messages, page.messages) }));
      setOlderCursor(page.olderCursor);
    } catch {
      /* 保持原样,按钮还在 */
    } finally {
      setLoadingOlder(false);
    }
  }, [api, threadId, olderCursor, loadingOlder]);

  const post = useCallback((frame: ClientFrame) => {
    const ws = wsRef.current;
    // socket 没开时**什么都不做** —— 与 Claude 那条一样,`send` 在没开时是空操作。
    // 界面上的表现由调用方看返回值决定(它要把草稿还回去),不要在这里静默排队。
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }, []);

  const send = useCallback(
    (text: string, images: CodexOutgoingImage[] = []): boolean => {
      const t = text.trim();
      // 只发图不打字是合法的("这张图什么问题"),与 Claude 那边同一条
      if (!t && images.length === 0) return false;

      const attachments = images.map((i) => ({ path: i.path, kind: "image" as const }));
      // ⚠️ 先试着发,**发出去了**才画本地回显 —— 反过来的话(先画再发)发不出去时
      // 那句就永远留在列表里,看起来像"发出去了但对方没回"
      if (!post({ t: "user_message", text: t, codexAttachments: attachments })) return false;

      /**
       * 本地回显。图的块用**手机自己的 URI** —— 服务端这一刻还没拿到这张图。
       * 重连补历史时同一张图会带着电脑上的路径回来,两条不可能撞车。
       */
      const blocks: ChatBlock[] = images.map((i) => ({
        type: "image" as const,
        mediaType: i.mediaType,
        path: i.localUri,
        size: i.size,
      }));
      if (t) blocks.push({ type: "text", text: t });
      setState((s) => ({
        ...s,
        messages: [...s.messages, { uuid: null, role: "user" as const, ts: null, blocks }],
        streaming: "",
      }));
      return true;
    },
    [post],
  );

  const interrupt = useCallback(() => void post({ t: "interrupt" }), [post]);

  const answer = useCallback(
    (reqId: string, decision: PermissionDecision) => {
      post({ t: "permission_response", reqId, decision });
      // 无论发没发出去都把卡片收掉:发不出去时留着它也没用(连接断了那一下的提示另有)
      setState((s) => dropApproval(s, reqId));
    },
    [post],
  );

  return {
    ...state,
    connected,
    loading,
    truncated: olderCursor !== null,
    olderCursor,
    loadingOlder,
    loadOlder,
    thread,
    send,
    interrupt,
    answer,
  };
}
