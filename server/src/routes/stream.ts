import type { FastifyInstance } from "fastify";
import { assertNoClaudeDesktopWriter } from "../desktop/native.ts";
import {
  MAX_IMAGES_PER_MESSAGE,
  PERMISSION_TIMEOUT_MINUTES,
  type ClientFrame,
  type ImageAttachment,
  type ServerFrame,
} from "@remote-cc/shared";
import { addSubscriber, getSession, onFrame, removeSubscriber } from "../cc/registry.ts";
import { elevated } from "../cc/elevated.ts";
import { armLiveness } from "../ws-liveness.ts";

/**
 * 回放"你不在时"那段输出的节奏。
 *
 * 帧本身不落任何地方(见 CcSession 的帧日志),切屏期间后端吐出来的 `assistant_delta`
 * 全都发给了当时并不存在的订阅者。以前回来只能靠 App 拉一页历史合并 —— 那是**一次跳变**:
 * 内容没有"经过"手机,看起来像卡了一下突然刷新。
 *
 * 所以按时间摊开重放一遍:整段花 REPLAY_MS 左右,但**最多分 REPLAY_STEPS 步** ——
 * 不然一个几千帧的长回答会生成几千个定时器,回放本身成了负担。
 */
const REPLAY_MS = 1_500;
const REPLAY_STEPS = 60;
import { MAX_IMAGE_BYTES, SUPPORTED_IMAGE_TYPES } from "../images.ts";

/**
 * 过滤手机送来的附件。
 *
 * 客户端不可信:类型不对的会在请求上游时被拒(而且报错很难懂),过大的会把
 * 帧撑爆。这里按白名单拦一道,并把上限卡在 Messages API 的单图天花板。
 */
function sanitizeImages(raw: ImageAttachment[] | undefined): ImageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ImageAttachment[] = [];
  // base64 比原字节膨胀约 4/3,按这个折算上限,免得 decoded 之前就吃满内存
  const maxBase64 = ((MAX_IMAGE_BYTES * 4) / 3 + 8) | 0;

  for (const img of raw.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    if (!img || typeof img !== "object") continue;
    if (typeof img.mediaType !== "string" || typeof img.data !== "string") continue;
    if (!SUPPORTED_IMAGE_TYPES.includes(img.mediaType)) continue;
    if (img.data.length > maxBase64) continue;
    out.push({ mediaType: img.mediaType, data: img.data });
  }
  return out;
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  const subscribers = new Map<string, Set<(frame: ServerFrame) => void>>();

  onFrame((runId, frame) => {
    for (const send of subscribers.get(runId) ?? []) {
      try {
        send(frame);
      } catch {
        /* 连接已断,由 close 事件清理 */
      }
    }
  });

  app.get("/api/sessions/:runId/stream", { websocket: true }, (socket, req) => {
    const { runId } = req.params as { runId: string };
    const session = getSession(runId);

    if (!session) {
      socket.send(
        JSON.stringify({ t: "error", message: "会话不存在或已结束", recoverable: false } satisfies ServerFrame),
      );
      socket.close();
      return;
    }

    const send = (frame: ServerFrame) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(frame));
    };

    let set = subscribers.get(runId);
    if (!set) {
      set = new Set();
      subscribers.set(runId, set);
    }
    set.add(send);
    addSubscriber(runId);

    let released = false;
    /** 心跳定时器。先把句柄留在这儿,`release` 才收得掉它 */
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    /** 探活定时器,同样由 `release` 收 */
    let stopLiveness: (() => void) | null = null;
    const release = () => {
      if (released) return;
      released = true;
      if (heartbeat) clearInterval(heartbeat);
      if (stopLiveness) stopLiveness();
      set?.delete(send);
      if (set && set.size === 0) subscribers.delete(runId);
      removeSubscriber(runId);
    };

    // 重连到已初始化的会话时补一帧,让 App 立刻知道它接的是哪个 CC 会话;
    // 新会话的 init 帧由 runner 发出,这里不抢先发以免 model 显示成 unknown
    if (session.ccSessionId) {
      send({
        t: "system",
        subtype: "init",
        sessionId: session.ccSessionId,
        model: "unknown",
        cwd: session.cwd,
        // shell 与终端专用命令要一起带上 —— 少了这两样,切一次屏 App 的
        // "命令卡片标注"和"斜杠命令拦截名单"就都空了(见 CcSession.initExtras)
        ...session.initExtras(),
      });
    }

    // ⚠️ 补发**当前权限模式**,以服务端为准。
    //
    // App 的选择器原本是纯本地 state:改动只往这边发一帧 `set_mode`,而发的时候
    // socket 没开(`send` 是 `wsRef.current?.send`,没开就什么都不做、不排队不报错)
    // 就静默丢了 —— 界面上显示新模式、后端跑旧模式,而且永远不会自愈。
    // 每次接入都推一帧真值,两边就此对齐。
    send({ t: "mode_changed", mode: session.permissionMode });

    // ⚠️ 补发**未决审批**。
    //
    // 切屏期间后端发出的 `permission_request` 帧没有任何订阅者接收,而帧不落任何地方,
    // 于是回来看到的是一片空白、卡片再也不出现,只能等 5 分钟超时被拒。
    // 补发之后,人回来时卡片还停在原地等人点。
    for (const pending of session.pendingApprovalFrames()) send(pending);

    /**
     * ⚠️ 补发**未决的提权请求**(红卡)。
     *
     * 和审批同一个道理,但更要紧:那张卡是**电脑上有个动作正卡在那里等人点**,
     * 而它只等 5 分钟。推送发出去的时候人可能压根不在 App 里,回来时卡还在不在,
     * 就取决于这一句。
     *
     * 红卡**不进帧日志**(见 CcSession.pushTransient),所以这里现取 —— 也正是
     * 这个设计的原因:批过的卡不该在重连时又冒出来一次。
     */
    for (const req of elevated.listPending()) {
      send({
        t: "elevated_request",
        reqId: req.reqId,
        action: req.action,
        title: req.title,
        detail: req.detail,
        caller: req.caller,
        reason: req.reason,
      });
    }

    // 最后补"过程":把没人看着时发出的那些帧**带节奏地重放一遍**。
    //
    // 排在 init / mode_changed / 审批补发之后是有意的 —— 那三样是"现在的状态",
    // 先把状态对齐,再补中间那段输出,不然界面会先显示一段过程、再跳回当前状态。
    //
    // ⚠️ 每一帧都**包一层 `replay`**(而不是原样重发)。因为 App 手上那份历史(seed)
    // 与这段回放在时间上**是重叠的** —— 帧里的输出 CLI 早写进 jsonl 了、也早被索引进
    // 历史了 —— 原样重发就会让同一段话出现两遍。包一层等于告诉 App"这是老内容,
    // 你有的就是同一条",由它按指纹认亲(见 protocol.ts 的 `replay` 帧与
    // useSessionStream 的处理)。使用者报的「agent 的话重复两遍甚至多遍」就是这里来的。
    /**
     * 客户端报"我收到哪了" —— 上次它应用的那一帧 `state` 带的 `seq`。
     *
     * 没报(新开的一条、或老版本 App)就走水位那条老路,行为与以前一样。
     */
    const { since } = req.query as { since?: string };
    const sinceSeq = since !== undefined && since !== "" && Number.isFinite(Number(since)) ? Number(since) : null;
    const { frames: missed, complete } = session.takeFramesToReplay(sinceSeq);

    /** 状态快照要**最后**发(见下面 sendState 的说明) */
    const sendState = () => send({ t: "state", ...session.stateSnapshot() });
    /**
     * 接入时那一帧**额外**带"补发够不够"。
     *
     * ⚠️ 只有接入那一帧带:客户端据此决定**要不要重拉历史**。心跳不带 ——
     * 那是"我还活着",与补发完整性无关,带上只会让人以为每次心跳都在重新判定。
     *
     * 次序也是保障:回放**完了**才发这一帧,所以客户端"应用了这一帧"就等于
     * "前面那些回放的帧我都收到了" —— 它报回来的 `since` 因此是可信的。
     */
    const sendAttachState = () => send({ t: "state", ...session.stateSnapshot(), catchupComplete: complete });

    if (missed.length > 0) {
      const steps = Math.min(REPLAY_STEPS, missed.length);
      const perStep = Math.ceil(missed.length / steps);
      const delay = Math.max(1, Math.round(REPLAY_MS / steps));
      let at = 0;
      const step = () => {
        if (socket.readyState !== 1) return; // 中途断了就别再排了
        for (const frame of missed.slice(at, at + perStep)) send({ t: "replay", frame });
        at += perStep;
        if (at < missed.length) setTimeout(step, delay);
        else sendAttachState(); // 回放完再对齐状态
      };
      step();
    } else {
      sendAttachState();
    }

    /**
     * **心跳:每 15 秒推一次状态快照**(忙闲都推)。
     *
     * 两件事靠它:
     *   ① 刷新 App 那边"最后收到一帧"的时刻 —— 它有个看门狗(忙而无帧就判连接已死、
     *      断线重连),而 agent 跑长时间不出声的东西(定时任务、几分钟不回话的工具调用)
     *      时**一帧都没有**,那个看门狗会把好端端的连接掐掉重连。有了心跳,这种情况
     *      下也一直有帧,"一直没有帧"就真的只剩"连接死了"这一种解释。
     *   ② 状态万一错过一帧(切屏、隧道抖一下),最多 15 秒就自己纠回来,不必等下次重连。
     *
     * ⚠️ 必须走**连接本地**的 `send`,不能走 `emit()`:后者会写帧日志(重连时被回放)
     * 并且**刷新 `lastActivityAt`** —— 心跳会把自己的静默时间归零,那个"已静默 N 分钟"
     * 就永远是 0,等于没做。
     */
    heartbeat = setInterval(sendState, 15_000);

    /**
     * **探活。**
     *
     * ⚠️ 这一条不是"顺手加个心跳",它决定三件事对不对(见 `ws-liveness.ts` 的文件头):
     * 通知该不该发、reaper 该不该回收、回放水位算得准不准 —— 全都按"有没有订阅者"走,
     * 而切后台时**悄悄烂掉**的连接会让它们**全都判成"还有人在"**。
     *
     * 最要命的是通知:烂连接会让"没人看着才发"判成"有人在看",于是**该通知时不通知**
     * —— 那比多弹一条糟得多。所以这条流和 Codex 那条流**共用同一份实现**,别让两边漂移。
     */
    stopLiveness = armLiveness(socket);

    socket.on("message", async (raw: Buffer) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(raw.toString()) as ClientFrame;
      } catch {
        send({ t: "error", message: "无法解析的消息帧", recoverable: true });
        return;
      }

      switch (frame.t) {
        case "user_message": {
          const images = sanitizeImages(frame.images);
          const text = frame.text ?? "";
          // 只发图不打字是合法的("这张图什么问题"),不能像以前那样要求 text 非空
          if (!text.trim() && images.length === 0) break;
          try {
            if (session.ccSessionId) await assertNoClaudeDesktopWriter(session.ccSessionId);
          } catch (error) {
            send({ t: "error", message: error instanceof Error ? error.message : "无法确认会话归属，消息未发送", recoverable: true });
            break;
          }
          try {
            session.send(text, images);
          } catch (err) {
            /**
             * ⚠️ **这条流已经结束了**(claude 子进程退出,`q` 被置空),而这个会话的
             * 条目还留在 registry 里 —— `CcSession.send` 现在会明确拒绝,不再把消息
             * push 进一个没有消费者的队列。
             *
             * 回一帧 `recoverable: false` 是有意的:App 的 `useSessionStream` 拿它
             * 触发自愈(resume 一条新的),并把刚打的字还回输入框。整条链路对应使用者
             * 反馈的「发消息会死 —— 一直正在思考,退出去重进来发现输入没写进 jsonl」。
             */
            send({
              t: "error",
              message: `这条会话在电脑上已经结束了(${String(err)}),正在重新唤醒`,
              recoverable: false,
            });
          }
          break;
        }
        case "permission_response": {
          // AskUserQuestion 的答案跟着审批回执一起回来,由 runner 合并进 updatedInput
          const result = session.respondPermission(frame.reqId, frame.decision, frame.reason, frame.answers);
          if (result !== "ok") {
            // 留痕:这行和 permissions.ts 里"超时被拒"那行合起来能分清责任 ——
            // 只有超时那行 = 回执没到;两行都有 = 回执到了但认不出(已超时,或发到了别的会话上)
            console.warn(`[审批] 收到认不出的回执 reqId=${frame.reqId}(${result})`);
          }
          /**
           * ⚠️ **成功也要回执**(见 protocol.ts 的 `approval_ack`)。
           *
           * 原来只在 `result !== "ok"` 时回一帧 `error`,于是"点完卡片关了、电脑却没
           * 收到"那条路**没有任何信号** —— 而它正是使用者说的"要点好几次":人不知道
           * 要不要再点,只能等。
           *
           * 也**不再发 `error` 帧**:那条路会让 App 把 `busy` 置闲,而审批超时被拒时
           * 这一轮**还在跑**(模型按"拒绝"继续往下走),置闲是错的。
           *
           * 三态的含义完全相反(超时 = 你回来晚了 / unknown = 已经点过了),所以
           * **说法由这里给**、App 照着显示 —— 两边各写一份措辞必然漂移。
           */
          send({
            t: "approval_ack",
            kind: "permission",
            reqId: frame.reqId,
            result,
            ...(result === "ok"
              ? {}
              : {
                  message:
                    result === "expired"
                      ? `这条审批已经超过 ${PERMISSION_TIMEOUT_MINUTES} 分钟没人应答,电脑那边按"拒绝"处理掉了 —— 需要的话让它重新发起一次`
                      : "这条审批已经被处理过了(可能你自己刚点过,或者另一台设备点过)",
                }),
          });
          break;
        }
        case "interrupt":
          void session.interrupt();
          break;

        /**
         * 提权请求的决定。
         *
         * 它和普通审批走**两条通道**:那张红卡的发起方不属于任何会话(是电脑上独立的
         * 提权脚本),所以决定要送进全局的 `elevated` 状态机,而不是这个会话的 broker。
         */
        case "elevated_response": {
          const result = elevated.respond(frame.reqId, frame.decision);
          // 和审批一样:**成功也回执**,失败的那两种说法由服务端给(见 approval_ack)
          send({
            t: "approval_ack",
            kind: "elevated",
            reqId: frame.reqId,
            result,
            ...(result === "ok"
              ? {}
              : {
                  message:
                    result === "expired"
                      ? "这条提权请求已经超时(电脑那边按拒绝走完了),需要的话让它重新发起一次"
                      : "这条提权请求已经被处理过了",
                }),
          });
          break;
        }
        case "set_mode":
          void session.setMode(frame.mode);
          break;
        default:
          break;
      }
    });

    socket.on("close", () => {
      release();

      // ⚠️ 这里**故意什么都不做**。
      //
      // 原来这里是"断开 20 秒后把未决审批全部拒绝"。它比审批自身的 5 分钟超时
      // 早得多,代价是切屏/息屏回来时审批全没了 —— 而"手机掉线后 PC 无人值守地执行"
      // 这个担心,超时本身就已经挡住了(拒绝是默认结局,晚一点失败没有任何越权风险)。
      // 现在改成:断开不动作,重连时按 listPending 补发(见上面)。
    });

    socket.on("error", () => {
      release();
    });

    req.log.info({ runId }, "手机已接入会话流");
  });
}
