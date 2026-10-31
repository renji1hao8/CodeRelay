import type { ChatBlock, ChatMessage, CodexThreadDetail, ServerFrame } from "./shared";

/**
 * Codex 聊天页的状态怎么随帧变化 —— **纯函数**。
 *
 * 与 `messageMerge.ts` / `billing.ts` / `appUpdate.ts` 同一个理由:能在裸 Node 里跑用例
 * (`scripts/check-codex-chat.mjs`)。这里最容易错的是一件很具体的事 ——
 * **服务端每次 `item/completed` 都发一遍"当前这条助手消息的全量块"**,所以收到它时
 * 要**整条替换**最后那条助手消息,而不是再追加一条;追加的话一次回答会碎成十几个气泡。
 *
 * ## 与 Claude 那边的差别
 *
 * Claude 的流是"增量 delta + 收尾一条完整 message",而且**重连要回放、要认亲**
 * (坑 40)。Codex 这边简单得多:历史**随时能重读**,所以重连就是重读一遍,
 * 不存在回放与去重的问题。这里也就没有那套指纹认亲。
 */

/** 一张等着回答的审批卡 */
export interface PendingApprovalCard {
  reqId: string;
  /** 「命令」「文件改动」… */
  tool: string;
  /**
   * 原始载荷。
   *
   * ⚠️ 类型故意和 `useSessionStream.ts::PendingApproval` 对齐(`Record<string, unknown>`)——
   * 于是这张卡能**原样喂给现有的 `ApprovalCard`**,一行都不用改。
   * 两边的 `reqId` / `tool` / `diff` 也同义,所以那个组件完全够用。
   */
  input: Record<string, unknown>;
  /** 能直接看的那段(命令原文 / 原因) */
  diff?: string;
}

export interface CodexChatState {
  /** 已经定格的对话(历史 + 服务端发来的完整消息) */
  messages: ChatMessage[];
  /** 正在流式吐出的那段文本。`assistant_message` 一到就清空(它已经在 blocks 里了) */
  streaming: string;
  busy: boolean;
  /** reqId → 卡片。回答之后要删掉 */
  approvals: PendingApprovalCard[];
  /** 最近一次错误,界面上显示一条提示;下一次成功动作时清掉 */
  error: string | null;
  /**
   * 累计 token 用量(整条会话)。`null` = 还不知道 —— 那时候头部**什么都不显示**。
   *
   * ⚠️ 它跟着 `state` 帧走,不是靠 delta 累加出来的:累加的话切一次屏就永久停在
   * 上次那个数上(与 Claude 那边 `state` 帧存在的理由同一条)。
   */
  tokens: number | null;
}

export const emptyChatState: CodexChatState = {
  messages: [],
  streaming: "",
  busy: false,
  approvals: [],
  error: null,
  tokens: null,
};

/** 打开会话时用历史铺一遍 */
export function seedChatState(detail: CodexThreadDetail): CodexChatState {
  return { ...emptyChatState, messages: detail.messages };
}

/**
 * 一帧作用到状态上。
 *
 * 返回新对象(不原地改)—— 直接给 React 的 setState 用。
 */
export function applyChatFrame(state: CodexChatState, frame: ServerFrame): CodexChatState {
  switch (frame?.t) {
    case "state": {
      const next: CodexChatState = { ...state, busy: !!frame.busy };
      /**
       * ⚠️ `tokens` 是**可选**字段:没带就保持原值,别清成 null。
       *
       * 旧后端根本不发它 —— 清掉的话每次 `turn/started` / `turn/completed` 推 state
       * 都会把头部那行"已消耗 N tokens"抹掉再等下一次重连才回来。
       * 而"这一条会话还没有任何用量"这件事,由**新会话一开始就是 null** 表达,不需要靠帧去清。
       */
      if (typeof frame.tokens === "number") next.tokens = frame.tokens;
      return next;
    }

    case "assistant_delta": {
      const text = typeof frame.text === "string" ? frame.text : "";
      if (!text) return state;
      return { ...state, streaming: state.streaming + text, busy: true };
    }

    case "assistant_message": {
      const blocks: ChatBlock[] = Array.isArray(frame.blocks) ? frame.blocks : [];
      if (blocks.length === 0) return state;
      const last = state.messages[state.messages.length - 1];
      /**
       * ⚠️ **整条替换**,不是追加。
       *
       * 服务端每完成一个 item 就发一遍"这条助手消息目前的全部块",所以:
       *   · 上一条是助手 → 用新的全量块**替换**它(否则一次回答碎成十几个气泡);
       *   · 上一条是用户(或压根没有)→ 起一条新的。
       */
      const messages =
        last && last.role === "assistant"
          ? [...state.messages.slice(0, -1), { ...last, blocks }]
          : [...state.messages, { uuid: null, role: "assistant" as const, ts: null, blocks }];
      // 这段文本已经在 blocks 里了 —— 留着会显示两遍
      return { ...state, messages, streaming: "", busy: true };
    }

    case "permission_request": {
      const reqId = typeof frame.reqId === "string" ? frame.reqId : "";
      if (!reqId || state.approvals.some((a) => a.reqId === reqId)) return state;
      const card: PendingApprovalCard = {
        reqId,
        tool: typeof frame.tool === "string" ? frame.tool : "Codex",
        // 载荷一定是对象(Codex 给的是 params);万一不是,给个空对象也别让它变成 undefined
        input: (frame.input && typeof frame.input === "object" ? frame.input : {}) as Record<string, unknown>,
      };
      if (typeof frame.diff === "string" && frame.diff) card.diff = frame.diff;
      return { ...state, approvals: [...state.approvals, card] };
    }

    case "result":
      // 这一轮说完了。streaming 该由 assistant_message 清掉了;万一没有(比如只回了一句
      // 空话),这里也清一下,免得那段文本永远挂在气泡外面。
      return { ...state, busy: false, streaming: "" };

    case "error":
      return { ...state, busy: false, error: typeof frame.message === "string" ? frame.message : "Codex 出错了" };

    default:
      // 其余帧(init / mode_changed / artifact / shell_*…)Codex 这条路不发,发了也不认
      return state;
  }
}

/** 回答完一条审批 → 把卡片去掉 */
export function dropApproval(state: CodexChatState, reqId: string): CodexChatState {
  return { ...state, approvals: state.approvals.filter((a) => a.reqId !== reqId) };
}

/** 一条消息里的纯文本(块里 text 那几段拼起来)。给认亲用 */
export function textOfMessage(m: ChatMessage): string {
  return m.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * 重连之后重读历史时,拿它把本地那份和拉回来的那份对上。
 *
 * ⚠️ **不能整份替换。** 和 Claude 那边的坑 40 是同一类问题:手机刚把一句话发出去,
 * 而服务端可能还没把它记进 items(`turn/start` 到落盘之间有个窗口)。整份替换的话
 * 那句会**当场消失**,使用者看到的是"我打的字自己没了",然后再过一会儿它又冒出来。
 *
 * 判据只能看**尾部**:刚发出去的那句只可能出现在末尾,所以只在"本地最后一条是用户消息、
 * 而拉回来的那几条里没有同样的话"时,把它补回去。
 */
export function mergeReseed(local: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const lastLocal = local[local.length - 1];
  if (!lastLocal || lastLocal.role !== "user") return incoming;
  const mine = textOfMessage(lastLocal);
  if (!mine) return incoming;
  const tail = incoming.slice(-4);
  if (tail.some((m) => m.role === "user" && textOfMessage(m) === mine)) return incoming;
  return [...incoming, lastLocal];
}

/**
 * 界面真正要画的消息列表 = 定格的 + 正在流式的那一条。
 *
 * 流式那段**只在有内容时**才补一个尾巴 —— 否则会画出一个空气泡,
 * 而它比"暂时什么都不显示"更让人以为卡住了。
 */
export function withStreaming(state: CodexChatState): ChatMessage[] {
  if (!state.streaming) return state.messages;
  const last = state.messages[state.messages.length - 1];
  // 已经是助手那条的话,并进去(它可能刚被 assistant_message 定格了一半)
  if (last && last.role === "assistant") {
    return [...state.messages.slice(0, -1), { ...last, blocks: [...last.blocks, { type: "text", text: state.streaming }] }];
  }
  return [...state.messages, { uuid: null, role: "assistant", ts: null, blocks: [{ type: "text", text: state.streaming }] }];
}

/**
 * 「加载更早」:把翻到的老一页**接在前面**,并去掉重复。
 *
 * ⚠️ 两页之间为什么会有重复:分页游标是按 item 走的,而 `messagesOfEntries` 会把
 * **相邻的助手条目并进同一条消息** —— 页边界正好切在那串里时,同一条消息会在两页里
 * 各出现一次(身份都是第一个 item 的 id,所以认得出)。不去重的话它会画成两个气泡。
 *
 * 身份只看 uuid。`uuid === null` 的是实时流建出来的消息(它们只可能在**尾部**),
 * 而老一页永远来自历史、带真 uuid —— 所以"本地没有 uuid 的那些"一律当新的放进来。
 */
export function prependOlder(current: ChatMessage[], older: ChatMessage[]): ChatMessage[] {
  const have = new Set(current.map((m) => m.uuid).filter((u): u is string => !!u));
  const fresh = older.filter((m) => !m.uuid || !have.has(m.uuid));
  return [...fresh, ...current];
}

/** 头部那一行"它现在在干什么" */
export interface CodexPhase {
  kind: "idle" | "thinking" | "outputting" | "approval";
  text: string;
}

/**
 * 状态 → 那一行提示。**纯函数**(照 Claude 那边 `useSessionStream.ts::derivePhase` 的写法)。
 *
 * ⚠️ 档位比 Claude 那边**少一半**:`question`(提问卡)、`tool`(正在跑工具)、
 * 提权那几档 Codex 都没有 —— 硬凑出来的档位会在界面上显示一句永远不出现的话。
 * 优先级也是同一个道理,**有卡等人点最要紧**(那时候它其实已经停下来了,
 * 说"正在跑"会让人白等)。
 */
export function deriveCodexPhase(state: CodexChatState): CodexPhase {
  if (state.approvals.length > 0) return { kind: "approval", text: "等你批准" };
  if (state.streaming) return { kind: "outputting", text: "正在输出" };
  if (state.busy) return { kind: "thinking", text: "Codex 正在跑…" };
  return { kind: "idle", text: "" };
}

/**
 * 「已消耗 N tokens」。缺失时**什么都不显示** —— 宁可空着,也不写一个 0。
 * 与 `ChatScreen.tsx::tokensLabel` 同一个口径(那边说的是同一件事)。
 */
export function tokensLabel(n: number | null | undefined): string {
  if (!n) return "";
  const s = n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return ` · 已消耗 ${s} tokens`;
}
