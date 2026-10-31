import type {
  AppReleaseResponse,
  ArtifactDetail,
  ArtifactSummary,
  CodexArtifactsResponse,
  CodexQuotaResponse,
  CodexThreadDetail,
  CodexThreadListResponse,
  CodexThreadSummary,
  DeviceSummary,
  DeleteIntentResponse,
  FsListResponse,
  FsReadResponse,
  FsRootsResponse,
  HealthResponse,
  PairClaimResponse,
  PermissionMode,
  RecoveryRestartResponse,
  SessionDetail,
  SessionSummary,
  UsageResponse,
  DesktopProvider, DesktopSessionPage, DesktopDetail, DesktopDelivery, AccountsResponse, DesktopControl, DesktopAction, DesktopActionResult,
} from "./shared";

interface ApiTarget {
  baseUrl: string;
  token: string | null;
  /** 单次请求的超时。组网链路可能抖动,不设超时的话会一直挂着,界面就一直转圈 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** GET 超时后自动重试几次。隧道建连有几率卡住,重试往往就通了 */
const MAX_RETRIES = 2;

export class ApiError extends Error {
  readonly status: number;
  /**
   * 是"连上了但对面一直不回"(超时),还是"根本没连上/连接被关掉"(立刻失败)。
   *
   * 这两者要分开:超时说明本地代理和隧道都还在,问题在电脑后端;立刻失败基本可以
   * 断定是回环代理或隧道没了 —— 调用方据此决定要不要重建组网节点。
   */
  readonly timedOut: boolean;

  constructor(status: number, message: string, timedOut = false) {
    super(message);
    this.status = status;
    this.timedOut = timedOut;
  }
}

/**
 * 把失败响应变成一句人话。
 *
 * ⚠️ 原来 body 是字符串就原样透传 —— 而隧道断时 nginx 回的是它自己的 HTML 错误页,
 * 于是手机上出现整屏红字 `<html><head><title>502 Bad Gateway</title>…`。
 * 那是给运维看的,不是给用户看的。
 */
function describeApiError(status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  if (status === 502 || status === 503 || status === 504) {
    return "电脑上的后端一时没接上(网关错误),几秒后会自动重试";
  }
  if (typeof body === "string") {
    const t = body.trim();
    // nginx 之类回的错误页:原样贴出来只会吓人
    if (t.startsWith("<")) {
      return `电脑返回了错误页(HTTP ${status}),多半是后端刚重启或链路抖了一下`;
    }
    return t.length > 300 ? `${t.slice(0, 300)}…` : t;
  }
  return `HTTP ${status}`;
}

export class Api {
  private baseUrl: string;
  private token: string | null;
  private timeoutMs: number;
  private healthFlight: Promise<HealthResponse> | null = null;

  constructor(target: ApiTarget) {
    this.baseUrl = target.baseUrl.replace(/\/+$/, "");
    this.token = target.token;
    this.timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  cacheKey(key: string): string { return `${this.baseUrl}:${this.token ?? ""}:${key}`; }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(path: string, init?: RequestInit, attempt = 0, policy?: { timeoutMs: number; retries: number }): Promise<T> {
    // 组网链路偶尔会挂住(连接建立了但响应回不来),没有超时的话 UI 会无限转圈。
    // 用 AbortController 兜住,把它变成一次快速失败,用户还能重试。
    const controller = new AbortController();
    const timeoutMs = policy?.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const method = (init?.method ?? "GET").toUpperCase();
    // 只自动重试幂等的 GET:POST 可能已经在服务端生效,重试会重复执行。
    // 退避 500ms / 1000ms —— 隧道抖动实测只有几十到几百毫秒(2026-09-19 那次是 94ms),
    // 一轮退避就足够跨过去。
    const canRetry = method === "GET" && attempt < (policy?.retries ?? MAX_RETRIES);
    const backoff = () => new Promise((r) => setTimeout(r, 500 * (attempt + 1)));

    let res: Response;
    let text: string;
    try {
      try {
        res = await fetch(this.baseUrl + path, { ...init, signal: controller.signal });
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";

        // ⚠️ 这里原来写的是 `aborted && method === "GET" && …` —— 只认超时。
        // 但隧道抖动的常见形态是**立刻失败**:连接被重置时 fetch 抛的是 TypeError,
        // 名字不是 AbortError,于是一次都不重试,用户直接看到红字。
        // 超时和"立刻失败"都该重试,唯一的分界线是 GET 与非 GET。
        if (canRetry) {
          await backoff();
          return this.request<T>(path, init, attempt + 1, policy);
        }

        throw new ApiError(
          0,
          aborted
            ? `连不上电脑:等了 ${Math.round(timeoutMs / 1000)} 秒没响应`
            : `连不上电脑(${this.baseUrl}):${String(err)}`,
          aborted,
        );
      }
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }

    // 网关错误也是"隧道那一瞬间没了":frps 上没有可用 tunnel 时 nginx 就回 502。
    // 它是**正常返回的响应**,不会走上面的 catch —— 所以必须在这里单独重试。
    if (canRetry && (res.status === 502 || res.status === 503 || res.status === 504)) {
      await backoff();
      return this.request<T>(path, init, attempt + 1, policy);
    }

    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      throw new ApiError(res.status, describeApiError(res.status, body));
    }
    return body as T;
  }

  private json<T>(path: string, method: string, payload: unknown): Promise<T> {
    return this.request<T>(path, {
      method,
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    });
  }

  // ---- 基础 ----
  health(): Promise<HealthResponse> {
    return this.healthFlight ??= this.request<HealthResponse>("/api/health", undefined, 0,
      { timeoutMs: 4000, retries: 0 }).finally(() => { this.healthFlight = null; });
  }

  desktopSessions(provider: DesktopProvider, cursor?: string): Promise<DesktopSessionPage> {
    return this.request(`/api/desktop/${provider}/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: this.headers() }, 0, { timeoutMs: 12000, retries: 0 });
  }
  desktopDetail(provider: DesktopProvider, id: string, cursor?: string): Promise<DesktopDetail> {
    return this.request(`/api/desktop/${provider}/sessions/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: this.headers() }, 0, { timeoutMs: 20000, retries: 0 });
  }
  desktopSend(provider: DesktopProvider, id: string, text: string, requestId: string): Promise<DesktopDelivery> {
    return this.json(`/api/desktop/${provider}/sessions/${encodeURIComponent(id)}/messages`, "POST", { text, requestId });
  }
  desktopOpen(provider: DesktopProvider, id: string): Promise<{ session: import("./shared").DesktopSession }> {
    return this.json(`/api/desktop/${provider}/sessions/${encodeURIComponent(id)}/open`, "POST", {});
  }
  desktopControl(provider: DesktopProvider, id: string): Promise<DesktopControl> {
    return this.request(`/api/desktop/${provider}/sessions/${encodeURIComponent(id)}/control`, { headers: this.headers() }, 0, { timeoutMs: 18000, retries: 0 });
  }
  desktopAction(provider: DesktopProvider, id: string, action: DesktopAction): Promise<DesktopActionResult> {
    return this.json(`/api/desktop/${provider}/sessions/${encodeURIComponent(id)}/control`, "POST", action);
  }
  desktopTaskOutput(provider: DesktopProvider, id: string, taskId: string): Promise<{ output: string; truncated: boolean }> {
    return this.request(`/api/desktop/${provider}/sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/output`, { headers: this.headers() }, 0, { timeoutMs: 18000, retries: 0 });
  }
  accounts(refresh = false): Promise<AccountsResponse> {
    return this.request(`/api/accounts${refresh ? "?refresh=1" : ""}`, { headers: this.headers() }, 0, { timeoutMs: 25000, retries: 0 });
  }

  // ---- 配对 ----
  claim(code: string, deviceName: string): Promise<PairClaimResponse> {
    return this.json<PairClaimResponse>("/api/pair/claim", "POST", { code, deviceName });
  }

  devices(): Promise<DeviceSummary[]> {
    return this.request<DeviceSummary[]>("/api/devices", { headers: this.headers() });
  }

  revokeDevice(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/api/devices/${id}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  // ---- 会话 ----

  /**
   * 会话列表。
   *
   * ⚠️ **默认不含归档的** —— 那正是归档的意义。要拿归档那批得 `archived: true`
   * (会话页底部那个折叠组展开时才拉,所以折叠着的时候不花这一次请求)。
   */
  sessions(query?: string, limit = 50, archived = false): Promise<SessionSummary[]> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (query) qs.set("q", query);
    if (archived) qs.set("archived", "1");
    return this.request<SessionSummary[]>(`/api/sessions?${qs}`, { headers: this.headers() });
  }

  /** 不带 beforeId 时给最新一页;带 beforeId 时给那一页之前的一页(往更早翻) */
  sessionDetail(id: string, beforeId?: number): Promise<SessionDetail> {
    const qs = beforeId ? `?beforeId=${beforeId}` : "";
    return this.request<SessionDetail>(`/api/sessions/${id}${qs}`, { headers: this.headers() });
  }

  liveSessions(): Promise<{ runId: string; ccSessionId: string | null; cwd: string; busy: boolean }[]> {
    return this.request(`/api/sessions/live`, { headers: this.headers() });
  }

  createSession(cwd: string, prompt: string, mode: PermissionMode) {
    return this.json<{ runId: string; ccSessionId: string | null; cwd: string; mode: PermissionMode }>(
      "/api/sessions",
      "POST",
      { cwd, prompt, mode, execution: "independent" },
    );
  }

  resumeSession(ccId: string, prompt: string | null, mode: PermissionMode, cwd?: string) {
    return this.json<{
      runId: string;
      ccSessionId: string | null;
      cwd: string;
      mode: PermissionMode;
      /** true = 服务端本来就有活着的会话,直接复用,不是新起一个 */
      reused?: boolean;
      /** 复用时它可能正在跑一轮 */
      busy?: boolean;
    }>(`/api/sessions/${ccId}/resume`, "POST", { prompt, mode, cwd, execution: "independent" });
  }

  /**
   * **改会话名**。传空串 = 恢复默认名(AI 起的名字 / 第一句话)。
   *
   * ⚠️ 名字是写进**电脑上那个会话的 jsonl** 的(权威源在那边),不是只改 SQLite ——
   * 所以电脑端的 `claude` / 桌面版也认这个名字,而库重建一次也不会丢。
   *
   * 返回改完之后的摘要(名字与来源),调用方拿它就地更新列表/标题。
   */
  renameSession(id: string, title: string): Promise<SessionSummary> {
    return this.json<SessionSummary>(`/api/sessions/${id}/title`, "POST", { title });
  }

  /**
   * **归档 / 取消归档一个会话**。
   *
   * ⚠️ 标记是写进**电脑上那个会话的 jsonl** 的(和改名同一条路),不是只改库 ——
   * 库重建一次不会丢,电脑端的 `claude` 也看得到。
   *
   * **归档不删任何东西**:消息、用量、文件都原样留着,`archiveSession(id, false)`
   * 之后一切照旧。
   *
   * 返回改完之后的摘要(带 `archived` / `archivedAt`),调用方拿它就地更新列表。
   */
  archiveSession(id: string, archived: boolean): Promise<SessionSummary> {
    return this.json<SessionSummary>(`/api/sessions/${id}/archive`, "POST", { archived });
  }

  /**
   * **主动结束一个会话** —— 让电脑上那个 claude 子进程真的退出。
   *
   * 改过环境变量 / 加过技能之后,只有让它重新起一次才会重新读。以前手机侧没有这条路,
   * 只能等后端把空闲会话回收掉(30 分钟)。
   *
   * ⚠️ 它**不动 jsonl**:聊天记录还在,下次进这个会话照样接着聊。
   */
  closeSession(runId: string) {
    return this.json<{ ok: boolean; ccSessionId: string | null }>(
      `/api/sessions/${runId}/close`,
      "POST",
      {},
    );
  }

  // ---- 文件 ----
  fsRoots(): Promise<FsRootsResponse> {
    return this.request<FsRootsResponse>("/api/fs/roots", { headers: this.headers() });
  }

  /**
   * 把长文本存成电脑上的文件,拿回它的路径。
   *
   * 用于绕开安卓剪贴板的 4096 字符上限:长内容不走剪贴板,而是把路径复制走 ——
   * 路径几十字节,永远塞得下,而且存下来的是完整内容,不会拿到半截。
   */
  exportText(text: string, hint?: string): Promise<{ path: string; bytes: number }> {
    return this.json("/api/export", "POST", { text, hint });
  }

  fsList(path: string): Promise<FsListResponse> {
    return this.request<FsListResponse>(`/api/fs/list?path=${encodeURIComponent(path)}`, {
      headers: this.headers(),
    });
  }

  fsRead(path: string): Promise<FsReadResponse> {
    return this.request<FsReadResponse>(`/api/fs/read?path=${encodeURIComponent(path)}`, {
      headers: this.headers(),
    });
  }

  fsDeleteIntent(path: string): Promise<DeleteIntentResponse> {
    return this.json<DeleteIntentResponse>("/api/fs/delete-intent", "POST", { path });
  }

  fsDelete(path: string, confirm: string): Promise<{ ok: boolean }> {
    const qs = new URLSearchParams({ path, confirm });
    return this.request<{ ok: boolean }>(`/api/fs/entry?${qs}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  fsMkdir(path: string): Promise<{ ok: boolean; path: string }> {
    return this.json("/api/fs/mkdir", "POST", { path });
  }

  /**
   * multipart 上传的公共部分。
   *
   * 这里刻意用 XMLHttpRequest 而不是 fetch:Expo 的 WinterCG fetch 自己拼 multipart 体,
   * 而它明确不支持 React Native 惯用的 {uri, name, type} 形式 —— 见
   * expo/src/winter/fetch/convertFormData.ts,转换时只认 string / Blob / 带 bytes() 的对象,
   * 走到最后会抛 "Unsupported FormDataPart implementation"。RN 自己的 XHR 一直支持 uri 形式,
   * 顺带还能拿到上传进度。
   */
  private uploadXhr<T>(
    path: string,
    form: FormData,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${this.baseUrl}${path}`);
      if (this.token) xhr.setRequestHeader("authorization", `Bearer ${this.token}`);
      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded, e.total);
        };
      }

      xhr.onload = () => {
        let body: unknown = null;
        try {
          body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          body = xhr.responseText;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body as T);
          return;
        }
        const message =
          body && typeof body === "object" && "error" in body
            ? String((body as { error: unknown }).error)
            : `HTTP ${xhr.status}`;
        reject(new ApiError(xhr.status, message));
      };
      xhr.onerror = () => reject(new ApiError(0, "上传失败(网络错误)"));
      xhr.ontimeout = () => reject(new ApiError(0, "上传超时"));
      xhr.send(form);
    });
  }

  /**
   * 上传一个文件到电脑上的 dirPath 目录。
   *
   * path 字段必须排在文件之前 —— 服务端先读它来决定落盘目录。
   */
  fsUpload(
    dirPath: string,
    file: { uri: string; name: string; mimeType: string },
    onProgress?: (sent: number, total: number) => void,
  ): Promise<{ ok: boolean; files: string[] }> {
    const form = new FormData();
    form.append("path", dirPath);
    form.append("file", { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
    return this.uploadXhr("/api/fs/upload", form, onProgress);
  }

  /**
   * 把手机上的一个文件传成**对话附件**。
   *
   * 与 fsUpload 的区别:落点由服务端定,调用方不用操心,返回值带**路径** ——
   * 这个路径要拼进消息正文,CC 靠它去读文件。
   *
   * 为什么非图片文件只能这么发:Agent SDK 的消息内容只认 text 与 image 两种块,
   * 任意文件塞不进去。"发文件"实际是"传到电脑上 + 把路径告诉 CC"。
   */
  attach(
    file: { uri: string; name: string; mimeType: string },
    onProgress?: (sent: number, total: number) => void,
  ): Promise<{ files: { name: string; path: string; size: number }[] }> {
    const form = new FormData();
    form.append("file", { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
    return this.uploadXhr("/api/attach", form, onProgress);
  }

  // ---- 产物 ----
  artifacts(sessionId?: string, limit = 50): Promise<ArtifactSummary[]> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (sessionId) qs.set("sessionId", sessionId);
    return this.request<ArtifactSummary[]>(`/api/artifacts?${qs}`, { headers: this.headers() });
  }

  artifact(id: string): Promise<ArtifactDetail> {
    return this.request<ArtifactDetail>(`/api/artifacts/${id}`, { headers: this.headers() });
  }

  commentArtifact(id: string, text: string, runId?: string): Promise<{ ok: boolean; runId: string }> {
    return this.json(`/api/artifacts/${id}/comment`, "POST", { text, runId });
  }

  // ---- 推送 / 审计 ----
  pushConfig(): Promise<{ provider: string; endpoint: string; topic: string; method: string; enabled: boolean }> {
    return this.request("/api/push/config", { headers: this.headers() });
  }

  setPushConfig(patch: Record<string, unknown>) {
    return this.json("/api/push/config", "POST", patch);
  }

  pushTest() {
    return this.json<{ sent: boolean; reason?: string }>("/api/push/test", "POST", {});
  }

  /**
   * 账单原料:逐条用量(峰谷要靠每条自己的时间,所以不能只取总数)。
   *
   * `since` 不传就是后端按"本地零点"给。界面通常传 `min(今日零点, 一小时前)` ——
   * 刚过零点时"近一小时"是跨昨天的。
   */
  usage(since?: string): Promise<UsageResponse> {
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    return this.request<UsageResponse>(`/api/usage${qs}`, { headers: this.headers() });
  }

  /**
   * 电脑上那个可供自更新的 APK 的版本信息。
   *
   * ⚠️ 电脑上没发布过包时后端回 **404**(不是空对象、也不是版本 0)—— 见
   * `server/src/routes/app-release.ts`。调用方要把它当"没有可更新的版本"处理,
   * 而不是当一次故障。
   */
  appRelease(): Promise<AppReleaseResponse> {
    return this.request<AppReleaseResponse>("/api/app/release", { headers: this.headers() });
  }

  /**
   * 排一次后端重启。
   *
   * ⚠️ **202 表示"排上了",不表示"已经重启"** —— 后端还要先等 `delaySec` 秒才动手。
   * 也正因如此,调用方拿到回应后**别再接着发请求**:这个动作会把后端连同手机这条
   * 会话流一起收掉(见 `server/src/routes/recovery.ts` 的说明)。
   */
  restartBackend(): Promise<RecoveryRestartResponse> {
    return this.json<RecoveryRestartResponse>("/api/recovery/restart", "POST", {});
  }

  /**
   * Codex(ChatGPT Plus 等)的额度快照。
   *
   * ⚠️ 它**不花额度** —— 后端走的是 Codex app-server 的一次协议调用,不是模型请求。
   * 所以点几次都无所谓。
   *
   * ⚠️ 这台机器上没装独立的 Codex CLI 时,后端回 **503** 并把原因写在 `body.error` 里。
   * 那对使用者是"去装一下",不是"出错了" —— 调用方要把它当**可预期的状态**显示,
   * 别渲染成一次故障(照 `describeApiError` 拿 `error` 那句话就行)。
   */
  codexQuota(): Promise<CodexQuotaResponse> {
    return this.request<CodexQuotaResponse>("/api/codex/quota", { headers: this.headers() });
  }

  /**
   * Codex 的会话列表。⚠️ 与 Claude 那份**是两个列表**(界面上用顶部切换分开)。
   *
   * 三个可选筛子都走**服务端**(Codex 自己的 `thread/list`):
   * `q` 是它按标题过滤的搜索词,`archived` 要归档那一份,`cursor` 往下翻页。
   * 不给 `q`/`cursor` 时后端会缓存这一份(20 秒),所以列表页的来回是最省的。
   */
  codexThreads(opts?: {
    q?: string;
    cursor?: string | null;
    archived?: boolean;
    limit?: number;
  }): Promise<CodexThreadListResponse> {
    const qs = new URLSearchParams();
    if (opts?.q) qs.set("q", opts.q);
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.archived) qs.set("archived", "1");
    if (opts?.limit) qs.set("limit", String(opts.limit));
    const suffix = qs.toString() ? `?${qs}` : "";
    return this.request<CodexThreadListResponse>(`/api/codex/threads${suffix}`, { headers: this.headers() });
  }

  /**
   * 一条 Codex 会话的历史**一页**。
   *
   * `before` 是上一次返回的 `olderCursor`(原样带回去,别解析)。
   * 不给 = 取最新那一页。
   *
   * ⚠️ `messages` 已经是**归一化过的 `ChatMessage`** —— 后端把 Codex 的 item 映射好了,
   * App 不需要知道 item 长什么样。
   */
  codexThread(id: string, before?: string | null): Promise<CodexThreadDetail> {
    const qs = before ? `?before=${encodeURIComponent(before)}` : "";
    return this.request<CodexThreadDetail>(`/api/codex/threads/${encodeURIComponent(id)}${qs}`, {
      headers: this.headers(),
    });
  }

  /** 新建一条 Codex 会话(可带第一句话) */
  codexStartThread(cwd: string, text: string | null): Promise<{ id: string }> {
    return this.json<{ id: string }>("/api/codex/threads", "POST", { cwd, text });
  }

  /**
   * 改 Codex 会话名。写进**电脑上那条会话里**,所以 Codex 桌面端也认。
   * 空串 = 抹掉自定义名(回落到摘要那行)。
   */
  codexRenameThread(id: string, name: string): Promise<{ ok: boolean }> {
    return this.json<{ ok: boolean }>(`/api/codex/threads/${encodeURIComponent(id)}/name`, "POST", { name });
  }

  /**
   * 归档 / 取消归档。
   *
   * ⚠️ 失败时后端回 **409** 并带一句人话 —— 常见原因是"这条会话正开在 Codex 桌面端"
   * (`already has an active writer`),那不是故障,别把它渲染成"后端坏了"。
   */
  codexArchiveThread(id: string, archived: boolean): Promise<{ ok: boolean }> {
    return this.json<{ ok: boolean }>(`/api/codex/threads/${encodeURIComponent(id)}/archive`, "POST", {
      archived,
    });
  }

  /**
   * 这条 Codex 会话动过哪些文件。
   *
   * ⚠️ 与 Claude 那条 `/api/artifacts` **是两条数据来源**(那边扫 jsonl,这边翻
   * `fileChange` item)。`complete === false` 表示更早的改动没算进来,界面要说一句。
   */
  codexArtifacts(id: string): Promise<CodexArtifactsResponse> {
    return this.request<CodexArtifactsResponse>(`/api/codex/threads/${encodeURIComponent(id)}/artifacts`, {
      headers: this.headers(),
    });
  }

  /** 一个 Codex 产物的详情(补丁 + 文件当前内容) */
  codexArtifact(id: string, artifactId: string): Promise<ArtifactDetail> {
    return this.request<ArtifactDetail>(
      `/api/codex/threads/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`,
      { headers: this.headers() },
    );
  }

  /** Codex 会话那条 WebSocket —— 与 Claude 那条是**两条独立通道** */
  codexStreamUrl(threadId: string): string {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    return `${wsBase}/api/codex/threads/${encodeURIComponent(threadId)}/stream${qs}`;
  }

  audit(limit = 100) {
    return this.request<
      { id: number; ts: string; action: string; target: string | null; result: string; detail: string | null }[]
    >(`/api/audit?limit=${limit}`, { headers: this.headers() });
  }

  // ---- URL 构造(给 Image / Linking 用)----
  fileUrl(path: string, inline = false): string {
    const qs = new URLSearchParams({ path, ...(inline ? { inline: "1" } : {}) });
    if (this.token) qs.set("token", this.token);
    return `${this.baseUrl}/api/fs/download?${qs}`;
  }

  /**
   * 带 token 的地址 —— 给**没法挂请求头的那两条链路**用:
   * 原生下载(`File.createDownloadTask`)和交给系统打开。WebSocket 同理。
   *
   * ⚠️ 别拿它去发普通 HTTP 请求:`request()` 走的是 `Authorization` 头,把 token
   * 放进查询串会多留下痕迹(而日志里出现 token 正是 HANDOVER #13 那条老账)。
   */
  authUrl(path: string): string {
    const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    return `${this.baseUrl}${path}${qs}`;
  }

  /** 自更新那个 APK 的下载地址 */
  appApkUrl(): string {
    return this.authUrl("/api/app/apk");
  }

  /** 诊断包 —— 由 `downloadUrlAndOpen` 落进使用者自己选的目录 */
  recoveryDiagnosticsUrl(): string {
    return this.authUrl("/api/recovery/diagnostics");
  }

  streamUrl(runId: string, since?: number | null): string {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const qs = new URLSearchParams();
    if (this.token) qs.set("token", this.token);
    /**
     * `since` = "我收到哪一帧了"(`state` 帧的 `seq`)。
     *
     * 带上它,服务端就能**精确补**那之后的内容,于是重连**不必重拉整页历史** ——
     * 实测这条链路上行只有 ~3 KB/s,一页 44KB 要十几秒。
     * 不带(新开一条、或老后端)就走原来的路。
     */
    if (since !== undefined && since !== null) qs.set("since", String(since));
    const q = qs.toString();
    return `${wsBase}/api/sessions/${runId}/stream${q ? `?${q}` : ""}`;
  }

  /**
   * **命令框**那条流。
   *
   * 它和会话流是两条**完全独立**的通道(后端 `/api/shell`,另一个路由):
   * 命令框跑的是使用者自己的手,不属于任何一条会话。
   */
  shellUrl(): string {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    return `${wsBase}/api/shell${qs}`;
  }
  terminalUrl(): string {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    return `${wsBase}/api/terminal${qs}`;
  }
}
