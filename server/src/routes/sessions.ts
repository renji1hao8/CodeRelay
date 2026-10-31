import fs from "node:fs";
import fsp from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { ChatMessage, PermissionMode, SessionDetail, SessionSummary, TitleSource } from "@remote-cc/shared";
import { allRows, db, nowIso, oneRow, recordAudit } from "../db.ts";
import { ensureIndexFresh } from "../history/indexer.ts";
import { parseSession } from "../history/parser.ts";
import { assertNoClaudeDesktopWriter } from "../desktop/native.ts";
import { deviceFromRequest } from "../auth.ts";
import { HttpError, httpError } from "../http.ts";
import {
  activeSessionForCcId,
  closeSession,
  createSession,
  getSession,
  listLive,
  resumeSession,
} from "../cc/registry.ts";

interface SessionRow {
  id: string;
  project_path: string | null;
  title: string | null;
  /** 标题来源(custom/ai/prompt)。见 shared 的 TitleSource */
  title_source: TitleSource | null;
  last_prompt: string | null;
  created_at: string | null;
  updated_at: string | null;
  message_count: number;
  /** 0/1。列是 `NOT NULL DEFAULT 0`,别写成可空 —— 见 db.ts 里那段说明 */
  archived: number | null;
  archived_at: string | null;
}

interface MessageRow {
  id: number;
  uuid: string | null;
  role: string;
  ts: string | null;
  content: string;
}

function toSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    projectPath: row.project_path,
    title: row.title,
    titleSource: row.title_source,
    lastPrompt: row.last_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    archived: row.archived === 1,
    archivedAt: row.archived_at,
  };
}

/**
 * 一次给多少条消息。
 *
 * ⚠️ **从 300 降到 60**(2026-09-27)。实测这条链路的**上行只有 ~15 KB/s**(frpc 走校园网),
 * 而 300 条的响应约 500KB —— 首屏就是三十几秒,使用者报的「重进明显卡顿」就是它。
 * 往上翻走 `beforeId`(App 那边叫「加载更早」)。
 */
const MESSAGE_PAGE = 60;

/** 调用方最多能要到多少。**封顶是故意留的** —— 再大就回到"首屏三十几秒"那个坑里 */
const MAX_MESSAGE_PAGE = 300;

/**
 * 首屏的思考块**整块丢掉**。
 *
 * ⚠️ 实测一次响应里 **thinking 占 45% 的字节**(227KB / 502KB),而这 227KB 是**纯浪费**:
 * `MessageBubble` 里**根本没有渲染 thinking 的分支**(它只画 text / compact_summary /
 * image / 工具块)—— 发过来就被丢掉了。而这条链路实测只有 ~15 KB/s。
 *
 * **丢了不算丢数据**:jsonl 才是权威源,库里也还存着全文,这里只是不上网。
 * 哪天要在手机上真显示思考,把这一句删掉就行 —— 那时它才重新值这个流量。
 */
function dropThinking(blocks: ChatMessage["blocks"]): ChatMessage["blocks"] {
  return blocks.filter((b) => b.type !== "thinking");
}

/**
 * 自定义会话名的长度上限。
 *
 * 和列表里的显示宽度对齐(一行放不下就只能靠 `numberOfLines` 截断,那看着像被吞了),
 * 超了就**明说**,不悄悄截断 —— 使用者改完名字发现少了一截,只会以为写坏了。
 */
const TITLE_MAX = 120;

/**
 * 文件最后一个字节是不是换行(`\n`)。
 *
 * 只在追加前用一次,所以开个 fd 读 1 个字节就够 —— 别为这个把整个文件读进来(最大的
 * 那份 33MB)。
 *
 * ⚠️ 出错时返回 **false**(= 要补换行)。两个方向都不致命,但并不对称:多补一个换行
 * 只是留一行空行,而解析器本来就跳过空行(`if (!line.trim()) continue`);少补一个则是
 * 把我们这一行拼到上一条屁股后面,那一行整个 JSON 解不出来,归档状态**静默**读不到。
 */
function endsWithNewline(filePath: string, size: number): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(1);
    const n = fs.readSync(fd, buf, 0, 1, size - 1);
    return n === 1 && buf[0] === 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * 起会话之前先确认工作目录真的存在。
 *
 * ⚠️ 为什么要挡这一下:`cwd` 不存在时,失败发生在**子进程**里 —— SDK 拿这个目录去
 * spawn `claude`,报出来是 `spawn ENOENT` 之类,再经 `pump()` 的 catch 变成
 * 「会话异常终止: Error: spawn …」推到手机上。而人看到的只是"会话起不来",
 * 第一反应会是查凭据、查隧道、查 cc-switch —— 目录是最不容易被想到的那一个。
 *
 * 前置判定把那句话换成 **「这个目录不存在: E:\xxx」**:一句照着就能去查的话。
 * 与 HANDOVER §3.5 那条"报错要能查得下去"是同一个规矩。
 */
async function assertCwdUsable(cwd: string): Promise<void> {
  let st;
  try {
    st = await fsp.stat(cwd);
  } catch {
    throw httpError(400, `这个目录不存在(或读不到):${cwd}`);
  }
  if (!st.isDirectory()) throw httpError(400, `这不是一个目录:${cwd}`);
}

/**
 * 起 / 续会话的统一外壳。
 *
 * `HttpError` 原样放行(那是我们自己写的人话);其余的包一句上下文再抛 ——
 * 全局 `setErrorHandler`(`index.ts`)会把 `message` 原样送到手机,所以这里的**前缀**
 * 决定了使用者看到的是"起会话失败: …",还是一句没头没尾的 SDK 报错。
 */
async function startGuard<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw httpError(500, `${what}失败:${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/sessions", async (req) => {
    ensureIndexFresh();
    const { q, limit, archived } = req.query as { q?: string; limit?: string; archived?: string };
    const take = Math.min(Number(limit) || 50, 200);
    /**
     * **归档的默认不出现** —— 那正是归档的意义(使用者原话:"不让他们污染当前的会话页")。
     * `?archived=1` 反过来,只回归档的,给会话页底部那个折叠组用(展开才拉)。
     *
     * ⚠️ 这里**没有**顺带回一个"归档了几条"。那得把返回值从数组改成对象,而读它的地方
     * 不止一处(`api.ts` / `smoke.mjs` / 几个探针),改形状的代价远大于收益 —— 折叠组
     * 没展开时不显示条数,展开拿到列表之后就有了。
     */
    const only = archived === "1" ? 1 : 0;

    const rows = q?.trim()
      ? allRows<SessionRow>(
          `SELECT * FROM sessions
           WHERE archived = ? AND (title LIKE ? OR last_prompt LIKE ? OR project_path LIKE ?)
           ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`,
          only,
          `%${q.trim()}%`,
          `%${q.trim()}%`,
          `%${q.trim()}%`,
          take,
        )
      : allRows<SessionRow>(
          `SELECT * FROM sessions WHERE archived = ?
           ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`,
          only,
          take,
        );

    return rows.map(toSummary);
  });

  app.get("/api/sessions/live", async () => listLive());

  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    ensureIndexFresh();
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) {
      return reply.code(404).send({ error: "会话不存在" });
    }

    // 默认给"最新的一页",带 beforeId 则给那一页之前的一页。
    // 先倒序取 N 条再翻回正序 —— 否则一个 400 条的会话打开时停在最旧一条,
    // 用户要手动往下滑几百屏才能看到最近的对话。
    const { beforeId, limit } = req.query as { beforeId?: string; limit?: string };
    const before = Number(beforeId) || 0;
    const pageSize = Math.min(Math.max(Number(limit) || MESSAGE_PAGE, 1), MAX_MESSAGE_PAGE);
    const desc = allRows<MessageRow>(
      before > 0
        ? "SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?"
        : "SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
      ...(before > 0 ? [id, before, pageSize] : [id, pageSize]),
    );
    const rows = desc.reverse();

    const firstId = rows[0]?.id ?? null;
    const hasOlder =
      firstId !== null &&
      oneRow<{ id: number }>(
        "SELECT id FROM messages WHERE session_id = ? AND id < ? LIMIT 1",
        id,
        firstId,
      ) !== undefined;

    const messages: ChatMessage[] = rows.map((r) => ({
      uuid: r.uuid,
      role: r.role === "assistant" ? "assistant" : "user",
      ts: r.ts,
      blocks: dropThinking(JSON.parse(r.content) as ChatMessage["blocks"]),
    }));

    const detail: SessionDetail = {
      ...toSummary(row),
      messages,
      olderCursor: hasOlder ? firstId : null,
    };
    return detail;
  });

  app.post("/api/sessions", async (req, reply) => {
    const device = deviceFromRequest(req);
    const body = req.body as { cwd?: string; prompt?: string; mode?: PermissionMode; execution?: string };
    if (body?.execution !== "independent") throw httpError(409, "新建 CLI 会话需显式选择独立运行");
    if (!body?.cwd || !body?.prompt) {
      return reply.code(400).send({ error: "需要 cwd 与 prompt" });
    }
    // 解构出来再往下走:下面那两处要进闭包,而 TS 不对闭包里的属性访问保持收窄
    const { cwd, prompt } = body;
    await assertCwdUsable(cwd);
    const session = await startGuard("起会话", () => createSession(cwd, body.mode ?? "ask"));
    session.send(prompt);
    recordAudit(device?.id ?? null, "session.create", cwd, "ok", prompt.slice(0, 200));
    return { runId: session.runId, ccSessionId: session.ccSessionId, cwd: session.cwd, mode: session.permissionMode };
  });

  app.post("/api/sessions/:id/resume", async (req, reply) => {
    const device = deviceFromRequest(req);
    const { id } = req.params as { id: string };
    // ⚠️ `mode` 的类型引用共享的 `PermissionMode`,别在这儿写死字面量联合 ——
    // 加档位时写死的那一份会把新档位静默挡在门外(TS 只在赋值处报,而这里是从
    // 请求体里读的,压根不会报)
    const body = req.body as { prompt?: string; cwd?: string; mode?: PermissionMode; execution?: string };
    if (body?.execution !== "independent") throw httpError(409, "续接请使用桌面同步；独立 CLI 运行需显式选择");
    try { await assertNoClaudeDesktopWriter(id); } catch (error) { throw httpError(409, error instanceof Error ? error.message : "无法核实桌面会话归属"); }

    // 已有活着的会话就直接复用:同一个 claude 进程接着聊,既没有并发写 jsonl 的风险,
    // 也不必为"用户自己几分钟前那次连接"报一个他无从理解的「另一端活跃」。
    // 真正的并发风险来自桌面版 —— 那是服务端看不到的,这条检查从来就拦不住它。
    const active = activeSessionForCcId(id);
    if (active) {
      // 复用时权限模式必须跟上,否则用户在列表里选的模式会被静默忽略
      if (body?.mode && active.permissionMode !== body.mode) await active.setMode(body.mode);
      if (body?.prompt) active.send(body.prompt);
      recordAudit(device?.id ?? null, "session.resume", id, "ok", `复用 ${body?.prompt?.slice(0, 200) ?? ""}`);
      return {
        runId: active.runId,
        ccSessionId: active.ccSessionId,
        cwd: active.cwd,
        mode: active.permissionMode,
        reused: true,
        busy: active.isBusy,
      };
    }

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    const cwd = body?.cwd ?? row?.project_path ?? undefined;
    if (!cwd) {
      return reply.code(400).send({ error: "无法确定该会话的工作目录,请在请求里带 cwd" });
    }
    // 续接尤其要挡:这条 `cwd` 常常是从库里那条老记录里取的 `project_path`,
    // 而那个项目可能早就被删了/改过名了 —— 那时报"目录不存在"比报 spawn 错清楚得多
    await assertCwdUsable(cwd);

    const session = await startGuard("续接会话", () => resumeSession(id, cwd, body?.mode ?? "ask"));
    if (body?.prompt) session.send(body.prompt);
    recordAudit(device?.id ?? null, "session.resume", id, "ok", body?.prompt?.slice(0, 200) ?? "");
    /**
     * ⚠️ **冷启动这条路也要带 `busy`。**
     *
     * 原来只有"复用了活进程"那条带它,于是 App 侧 `reusedBusy` 是 undefined、
     * `initialBusy === true` 为假 —— 进页面就是空闲态:不显示"正在思考"、也没有暂停键,
     * 要等流接上、`state` 帧到达才纠正。而那一帧排在回放**之后**(回放按 1.5 秒一帧摊开),
     * 中间是好几秒的空窗。使用者报的「重进不显示暂停接口和思考中」就在这一段。
     *
     * 新起的会话多半是闲的,但 `prompt` 一并发出去时它立刻就是忙的 —— 那种情况下
     * 少这个字段同样会闪一下空闲态。
     */
    return {
      runId: session.runId,
      ccSessionId: session.ccSessionId,
      cwd: session.cwd,
      mode: session.permissionMode,
      busy: session.isBusy,
    };
  });

  /**
   * **自定义会话名**。
   *
   * 名子写进**会话的 jsonl**(`{"type":"custom-title","customTitle":…}`),不是只改
   * SQLite 那一行 —— 库在这个项目里是**可以随便删的派生数据**(见根 CLAUDE.md 的
   * 「可以随便删的东西」),只存库里的名字下次重建就没了;写进 jsonl 则电脑端的
   * `claude` / 桌面版也看得到。库里那行只是**顺手同步一下**好让界面立刻反映出来
   * (列表是读库的,而索引是 2 秒节流的)。
   *
   * 传空串 = **恢复默认名**(AI 起的名字 / 第一句话)。这一趟要**从头重解析**那个文件:
   * 回落值在文件靠前的地方,增量索引那一段里没有(见 parser 的 `custom-title` 分支)。
   * 代价是读一遍文件(最大的那份 33MB,一秒上下),而这是个极少发生的显式动作。
   */
  app.post("/api/sessions/:id/title", async (req, reply) => {
    const device = deviceFromRequest(req);
    const { id } = req.params as { id: string };
    const body = req.body as { title?: unknown };
    const raw = typeof body?.title === "string" ? body.title : "";

    // ⚠️ 换行必须清掉:那是往 jsonl 里追加一行,名字里带 `\n` 就等于把一行拆成两行,
    // 读的那头按行解析 → 后面那些字节全成了坏行。顺带把连续空白收成一个。
    const title = raw.replace(/\s+/g, " ").trim();
    if (title.length > TITLE_MAX) {
      return reply.code(400).send({ error: `名字最多 ${TITLE_MAX} 个字` });
    }

    ensureIndexFresh();
    let row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) {
      // 刚建的会话可能还没被索引进来(索引平时是 2 秒节流的)→ 强制扫一次再找
      ensureIndexFresh(true);
      row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    }
    if (!row) {
      return reply.code(404).send({ error: "索引里没有这个会话(它可能还没落盘),等它写出第一条记录再改名" });
    }
    const filePath = (
      db.prepare("SELECT file_path FROM sessions WHERE id = ?").get(id) as { file_path: string }
    ).file_path;

    /**
     * ⚠️ **追加是安全的**,哪怕那个会话正在跑:`claude` 也是往文件尾追加,而我们这一行
     * 一次写完(`appendFileSync` 单个小写入),两边各写各的行、不会互相截断。
     * 万一它随后被压缩重写(文件被截短重写),这一行丢了也不致命:库里那行还在,
     * 而"已经有了就不动"的规则会保住它(见 indexer 的 pickTitle)。
     */
    try {
      fs.appendFileSync(
        filePath,
        `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId: id })}\n`,
        "utf8",
      );
    } catch (err) {
      return reply.code(500).send({ error: `改不了:写不进那个会话的文件(${String(err)})` });
    }

    if (title) {
      db.prepare("UPDATE sessions SET title = ?, title_source = 'custom' WHERE id = ?").run(title, id);
    } else {
      const parsed = parseSession(filePath, 0, id);
      db.prepare("UPDATE sessions SET title = ?, title_source = ? WHERE id = ?").run(
        parsed.title,
        parsed.titleSource,
        id,
      );
    }
    recordAudit(device?.id ?? null, "session.rename", id, "ok", title || "(恢复默认名)");
    const updated = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return toSummary(updated ?? row);
  });

  /**
   * **归档 / 取消归档**。
   *
   * 走的和改会话名是同一条路:往会话的 **jsonl 追加一行**,而不是只改 SQLite。
   * 理由也一样 —— 库在这个项目里是**可以随便删的派生数据**(见根 CLAUDE.md),
   * 只改库的话下次重建就全没了;写进 jsonl,连电脑端的 `claude` 也看得到这个标记。
   * 库里那行只是顺手同步,好让界面**立刻**反映出来(索引是 2 秒节流的)。
   *
   * ⚠️ **为什么不是"把文件搬进另一个目录"**(使用者最初提的两个思路之一):
   *
   *   · 一个会话其实是**两份东西** —— `<uuid>.jsonl` **和同名的那个目录**(里面装着
   *     `subagents/`、`tool-results/`)。搬要搬两处,还得另存一份"原本在哪";那份清单
   *     一旦丢了就真丢了。
   *   · 更要命的是索引器的幽灵清理:它拿 `sessions.file_path` 去比 `sessionFiles()`,
   *     而 `if (size === offset) return` 那条早退(**字节数没变就不重解析**)会让搬走的
   *     文件**不刷新 `file_path`** → 被判成幽灵、连 `messages` 一起删掉,下一轮再从零
   *     整份重建。
   *   · 标记法**不动路径**,只是让文件变长,增量解析必然跑到,上面那些全都不用操心。
   *
   * 归档**不删任何东西**:用量、消息、文件都不动,取消归档之后一切照旧。
   *
   * ⚠️ CLI 大概率会忽略这个它不认识的条目类型(`last-prompt` 之类它本来就在忽略),
   * 但这条**验过才算数** —— 见 `scripts/probe-archive.mjs` 里那步"追加之后还能不能
   * 正常 resume"。
   */
  app.post("/api/sessions/:id/archive", async (req, reply) => {
    const device = deviceFromRequest(req);
    const { id } = req.params as { id: string };
    const body = req.body as { archived?: unknown };
    if (typeof body?.archived !== "boolean") {
      return reply.code(400).send({ error: "archived 要给 true 或 false" });
    }
    const want = body.archived;

    ensureIndexFresh();
    let row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) {
      // 刚建的会话可能还没被索引进来(索引平时是 2 秒节流的)→ 强制扫一次再找
      ensureIndexFresh(true);
      row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    }
    if (!row) {
      return reply.code(404).send({ error: "索引里没有这个会话(它可能还没落盘),等它写出第一条记录再归档" });
    }
    const filePath = (
      db.prepare("SELECT file_path FROM sessions WHERE id = ?").get(id) as { file_path: string }
    ).file_path;

    /**
     * ⚠️ 换行是**不能有**的(这里一个字节都不来自使用者输入),但 `JSON.stringify`
     * 出来的那一行必须以 `\n` 收尾 —— 追加在文件尾时,前一行**未必**带换行符
     * (CLI 写最后一条时可能还没收尾),不补的话我们这一行会被拼到上一条屁股后面,
     * 读的那头整行 JSON 都解不出来,于是归档状态**静默**读不到。
     *
     * 所以先看一眼文件尾是不是换行,不是就先补一个。
     */
    const at = nowIso();
    try {
      const size = fs.statSync(filePath).size;
      const needsNewline = size > 0 && !endsWithNewline(filePath, size);
      fs.appendFileSync(
        filePath,
        `${needsNewline ? "\n" : ""}${JSON.stringify({ type: "custom-archived", archived: want, sessionId: id, at })}\n`,
        "utf8",
      );
    } catch (err) {
      return reply.code(500).send({ error: `改不了:写不进那个会话的文件(${String(err)})` });
    }

    db.prepare("UPDATE sessions SET archived = ?, archived_at = ? WHERE id = ?").run(
      want ? 1 : 0,
      want ? at : null,
      id,
    );
    recordAudit(device?.id ?? null, "session.archive", id, "ok", want ? "归档" : "取消归档");
    const updated = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return toSummary(updated ?? row);
  });

  app.post("/api/sessions/:runId/interrupt", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const session = getSession(runId);
    if (!session) return reply.code(404).send({ error: "没有这个运行中的会话" });
    await session.interrupt();
    recordAudit(deviceFromRequest(req)?.id ?? null, "session.interrupt", runId, "ok");
    return { ok: true, at: nowIso() };
  });

  /**
   * **主动结束一个会话** —— 把电脑上那个 claude 子进程真正收掉。
   *
   * 为什么需要它(使用者反馈的第 14 条:「/exit 命令不被支持,导致我不能主动结束进程,
   * 在一些我更新了环境变量或技能的情况下不能重新载入对话」):
   *
   * 在那之前,手机侧**没有任何办法**结束一个会话 —— 只能等空闲回收器(30 分钟没人看着)
   * 或者重启后端。而"我改了环境变量 / 加了技能,想让它重新读一遍"是个很日常的需求,
   * 等半小时显然不合理。
   *
   * `CcSession.close()` 一直是写好的(拒掉未决审批 + 关输入 + abort 真杀子进程),
   * 只是没有接口暴露出来。这里把它接上:关掉之后**再进这个会话就是一条全新的进程**,
   * 环境变量、技能、CLAUDE.md 全部重新加载。
   *
   * ⚠️ 它**不动 jsonl**:聊天记录还在,下次 resume 照样能接着聊。
   */
  app.post("/api/sessions/:runId/close", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const session = getSession(runId);
    if (!session) return reply.code(404).send({ error: "没有这个运行中的会话" });
    // ccSessionId 要在 close() 之前取 —— close 之后 registry 里的映射就摘掉了
    const ccSessionId = session.ccSessionId;
    if (!closeSession(runId)) return reply.code(404).send({ error: "没有这个运行中的会话" });
    recordAudit(deviceFromRequest(req)?.id ?? null, "session.close", ccSessionId ?? runId, "ok");
    return { ok: true, ccSessionId, at: nowIso() };
  });
}
