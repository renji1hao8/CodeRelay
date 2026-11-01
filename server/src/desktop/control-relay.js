/* Runs only in the verified desktop renderer. No caller-supplied code or methods. */
(() => {
  if (globalThis.__remoteccControl?.version === 2) return;
  const approvals = new Map(), replies = new Map(), taskSets = new Map(), initialReads = new Map(), submitted = new Map();
  const claude = globalThis['claude.web']?.LocalSessions;
  const electron = globalThis.electronBridge;
  const running = status => ['running', 'pending', 'paused', 'in_progress', 'inProgress'].includes(status);
  const fail = message => { throw new Error(message); };
  const capped = map => { while (map.size > 100) map.delete(map.keys().next().value); };
  const key = id => String(id);
  const codexApprovalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']);
  const codexApproval = request => {
    const p = request.params || {};
    if (request.method === 'mcpServer/elicitation/request') {
      const meta = p._meta || {};
      const connector = String(meta.connector_id || '').trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-');
      // Only the native Computer Use boolean approval is delegatable here.
      // Auth, user-verification, arbitrary forms and execution-bound approvals
      // stay on Desktop; never synthesize form answers or persistent grants.
      const schema = p.requestedSchema;
      const app = meta.tool_params?.app;
      const canAllow = p.mode === 'form' && meta.codex_approval_kind === 'mcp_tool_call' &&
        (connector === 'computer-use' || connector.startsWith('computer-use-')) &&
        typeof meta.tool_name === 'string' && typeof app === 'string' && !!app.trim() &&
        schema?.type === 'object' && schema.properties && Object.keys(schema.properties).length === 0 &&
        (!schema.required || schema.required.length === 0) && !meta.approveDisabled && !meta.executionBound &&
        !p.requiresUserInteraction && !p.onlyOnCard && !p.approveDisabled && !p.executionBound && !meta.requiresUserInteraction;
      return { id: key(request.id), tool: '应用访问', description: canAllow ? `允许本次操作 ${app}？${p.message ? '\n' + p.message : ''}` : '此确认需要在电脑上处理',
        input: canAllow ? { app, tool: meta.tool_name, parameters: meta.tool_params } : { mode: p.mode, server: p.serverName }, canAllow };
    }
    if (request.method === 'item/permissions/requestApproval') return { id: key(request.id), tool: '权限申请', description: p.reason || '此权限申请需要在电脑上处理', input: p.permissions, canAllow: false };
    return { id: key(request.id), tool: request.method === 'item/commandExecution/requestApproval' ? 'Bash' : 'Edit', description: p.reason || '', input: p, canAllow: true };
  };
  const acceptTaskEvent = (sessionId, message) => {
    if (!message) return;
    let state = taskSets.get(sessionId);
    if (!state) { state = { tasks: new Map(), known: false }; taskSets.set(sessionId, state); capped(taskSets); }
    if (message.type === 'user' && typeof message.uuid === 'string') state.turnKey = message.uuid;
    if (message.type !== 'system') return;
    if (message.subtype === 'background_tasks_changed' && Array.isArray(message.tasks)) {
      const next = new Map();
      for (const task of message.tasks) if (typeof task.task_id === 'string') {
        next.set(task.task_id, { ...state.tasks.get(task.task_id), id: task.task_id, description: task.description || '后台任务', status: 'running', canStop: true });
      }
      state.tasks = next; state.known = true;
    }
    const id = message.task_id;
    if (typeof id !== 'string') return;
    const old = state.tasks.get(id);
    if (message.subtype === 'task_started' && message.is_backgrounded === true) {
      state.tasks.set(id, { id, description: message.description || '后台任务', status: 'running', canStop: true });
    } else if (old && message.subtype === 'task_progress') {
      if (message.description) old.description = message.description;
      if (message.summary) old.summary = message.summary;
    } else if (old && message.subtype === 'task_updated') {
      if (message.patch?.status) { old.status = message.patch.status; old.canStop = running(old.status); }
    } else if (old && message.subtype === 'task_notification') {
      old.status = message.status || 'completed'; old.canStop = false; old.summary = message.summary;
    }
    capped(state.tasks);
  };
  if (claude?.onOnEvent) claude.onOnEvent(event => {
    if (event.type === 'message') {
      const state = taskSets.get(event.sessionId);
      if (state?.buffer) state.buffer.push(event.message);
      else acceptTaskEvent(event.sessionId, event.message);
    }
  });
  if (electron) globalThis.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.hostId !== 'local') return;
    if (data.type === 'mcp-response') {
      const waiter = replies.get(key(data.message?.id));
      if (waiter) { replies.delete(key(data.message.id)); clearTimeout(waiter.timer); data.message.error ? waiter.reject(new Error('电脑未能完成操作')) : waiter.resolve(data.message.result); }
    } else if (data.type === 'mcp-request') {
      const r = data.request;
      if (codexApprovalMethods.has(r?.method) && ['string', 'number'].includes(typeof r.id) && typeof r.params?.threadId === 'string') {
        approvals.set(key(r.id), r); capped(approvals);
      }
    } else if (data.type === 'mcp-notification') {
      if (data.method === 'serverRequest/resolved') approvals.delete(key(data.params?.requestId));
      if (data.method === 'turn/completed') for (const [id, r] of approvals) if (r.params?.threadId === data.params?.threadId && r.params?.turnId === data.params?.turn?.id) approvals.delete(id);
    }
  });
  async function rpc(method, params) {
    if (!['thread/turns/list', 'turn/interrupt'].includes(method)) fail('不支持此操作');
    const id = 'remotecc-' + crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { replies.delete(id); reject(new Error('电脑尚未确认操作，请刷新查看')); }, 8000);
      replies.set(id, { resolve, reject, timer });
      Promise.resolve(electron.sendMessageFromView({ type: 'mcp-request', hostId: 'local', request: { id, method, params } })).catch(error => { clearTimeout(timer); replies.delete(id); reject(error); });
    });
  }
  async function claudeState(id) {
    const session = await claude.getSession(id);
    if (!session || session.sessionId !== id) fail('电脑会话已关闭');
    if (!taskSets.get(id)?.initialized) {
      if (!initialReads.has(id)) initialReads.set(id, (async () => {
        const state = taskSets.get(id) || { tasks: new Map(), known: false };
        state.buffer = []; taskSets.set(id, state); capped(taskSets);
        try {
          const transcript = await claude.getTranscriptTail(id, 500);
          for (const message of transcript?.messages || []) acceptTaskEvent(id, message);
          for (const message of state.buffer) acceptTaskEvent(id, message);
          state.initialized = true;
        } finally { delete state.buffer; initialReads.delete(id); }
      })());
      await initialReads.get(id);
    }
    const state = taskSets.get(id);
    const pending = Array.isArray(session.pendingToolPermissions) ? session.pendingToolPermissions : [];
    const turnKey = session.lastTurnEdgeAt !== undefined ? String(session.lastTurnEdgeAt) : state.turnKey || null;
    return { connected: true, canInterrupt: !!session.turnRunning && !!turnKey, turnKey: session.turnRunning ? turnKey : null,
      approvals: pending.map(r => ({ id: String(r.requestId), tool: r.toolName, description: r.description || r.input?.description || '', input: r.input,
        canAllow: !r.requiresUserInteraction && !r.onlyOnCard && !r.noAllowOnNotification && /^(Bash|PowerShell|Read|Write|Edit|MultiEdit|Glob|Grep|WebFetch|WebSearch|Task|Agent|NotebookEdit)$/.test(r.toolName) })),
      tasks: [...state.tasks.values()].map(task => ({ ...task, canStop: task.canStop && !!session.hasBackgroundWork, status: task.canStop && !session.hasBackgroundWork ? 'completed' : task.status })), tasksKnown: state.known || !session.hasBackgroundWork,
      notice: session.hasBackgroundWork && !state.known ? '正在接收后台任务状态，新任务会自动出现' : undefined };
  }
  async function codexState(id) {
    const raw = await rpc('thread/turns/list', { threadId: id, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' });
    if (!Array.isArray(raw?.data)) fail('电脑会话状态暂不可用');
    const turn = raw.data.find(t => t.status === 'inProgress');
    return { connected: true, canInterrupt: !!turn, turnKey: turn?.id ?? null, tasks: [], tasksKnown: true,
      approvals: [...approvals.values()].filter(r => r.params?.threadId === id && (!r.params.turnId || r.params.turnId === turn?.id)).map(codexApproval),
      notice: '审批会在电脑连接期间自动同步' };
  }
  const snapshot = id => claude ? claudeState(id) : codexState(id);
  const claim = (id, action) => {
    const k = id + ':' + action.type + ':' + (action.requestId || action.taskId || action.turnKey);
    if (submitted.has(k)) fail('操作已提交，请等待电脑更新状态');
    submitted.set(k, true); capped(submitted);
  };
  globalThis.__remoteccControl = { version: 2, snapshot, async action(id, action) {
    const state = await snapshot(id);
    if (action.type === 'interrupt') {
      if (!state.canInterrupt || state.turnKey !== action.turnKey) fail('这一轮已经结束，请刷新会话');
      claim(id, action);
      if (claude) await claude.interrupt(id);
      else await rpc('turn/interrupt', { threadId: id, turnId: state.turnKey });
      return { status: 'submitted', notice: '已请求停止，正在同步状态' };
    }
    if (action.type === 'stopTask' && claude) {
      if (!state.tasks.some(t => t.id === action.taskId && t.canStop)) fail('任务已结束或不在当前会话');
      claim(id, action);
      await claude.stopTask(id, action.taskId);
      return { status: 'submitted', notice: '已请求停止此任务，正在同步状态' };
    }
    if (action.type === 'approval' && ['allow', 'deny'].includes(action.decision)) {
      const pending = state.approvals.find(r => r.id === action.requestId);
      if (!pending) fail('审批已处理或已失效');
      if (action.decision === 'allow' && !pending.canAllow) fail('这项审批需要在电脑上确认');
      claim(id, action);
      if (claude) await claude.respondToToolPermission(action.requestId, action.decision === 'allow' ? 'once' : 'deny');
      else {
        const request = approvals.get(action.requestId);
        if (!request) fail('审批已失效');
        const result = request.method === 'mcpServer/elicitation/request' ? { action: action.decision === 'allow' ? 'accept' : 'decline' } :
          request.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: action.decision === 'allow' ? 'accept' : 'decline' };
        await electron.sendMessageFromView({ type: 'mcp-response', hostId: 'local', threadId: id, requestMethod: request.method, response: { id: request.id, result } });
      }
      return { status: 'submitted', notice: '已提交审批，等待电脑确认' };
    }
    fail('不支持此操作');
  }, async output(id, taskId) {
    if (!claude) fail('当前会话不支持查看后台输出');
    const state = await snapshot(id);
    if (!state.tasks.some(t => t.id === taskId)) fail('任务不在当前会话');
    const result = await claude.getTaskOutput(id, taskId);
    return { output: String(result?.output ?? '').slice(-12000), truncated: !!result?.truncated };
  } };
})();
