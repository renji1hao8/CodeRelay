import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const source = await fs.readFile(new URL('../src/desktop/control-relay.js', import.meta.url), 'utf8');
let passed = 0;
async function test(name, work) { await work(); passed++; console.log('OK', name); }
function harness(extra) {
  const listeners = [];
  const context = vm.createContext({ setTimeout, clearTimeout, crypto: { randomUUID }, addEventListener: (type, callback) => { if (type === 'message') listeners.push(callback); }, ...extra });
  vm.runInContext(source, context);
  return { context, relay: context.__remoteccControl, emit: data => listeners.forEach(listener => listener({ data })) };
}
const events = [], calls = [];
const sessions = {
  A: { sessionId: 'A', turnRunning: true, hasBackgroundWork: true, lastTurnEdgeAt: 123, pendingToolPermissions: [{ requestId: 'approve-A', toolName: 'Bash', description: '运行检查', input: { command: 'npm test' } }] },
  B: { sessionId: 'B', turnRunning: false, hasBackgroundWork: false, pendingToolPermissions: [] },
};
const claude = harness({ 'claude.web': { LocalSessions: {
  onOnEvent: callback => events.push(callback), getSession: async id => sessions[id] || null,
  getTranscriptTail: async id => ({ messages: id === 'A' ? [{ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-A', description: '后台检查' }, { task_id: 'task-B', description: '第二项检查' }] }] : [] }),
  stopTask: async (...args) => calls.push(['stop', ...args]), interrupt: async (...args) => calls.push(['interrupt', ...args]),
  respondToToolPermission: async (...args) => calls.push(['approve', ...args]), getTaskOutput: async () => ({ output: '输出', truncated: false }),
} } });
await test('直接显示审批描述与完整后台快照', async () => {
  const s = await claude.relay.snapshot('A'); assert.equal(s.approvals[0].description, '运行检查'); assert.equal(s.tasks.length, 2); assert.equal(s.tasksKnown, true);
});
await test('只能停止当前会话中的指定任务', async () => {
  await claude.relay.action('A', { type: 'stopTask', taskId: 'task-A' }); assert.deepEqual(calls.at(-1), ['stop', 'A', 'task-A']);
  const count = calls.length; await assert.rejects(claude.relay.action('B', { type: 'stopTask', taskId: 'task-A' })); assert.equal(calls.length, count);
});
await test('完整任务快照采用替换语义，结束的任务无法再停止', async () => {
  events[0]({ type: 'message', sessionId: 'A', message: { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-B', description: '第二项检查' }] } });
  assert.equal((await claude.relay.snapshot('A')).tasks.length, 1); await assert.rejects(claude.relay.action('A', { type: 'stopTask', taskId: 'task-A' }));
});
await test('失效审批与跨会话审批不提交', async () => {
  const count = calls.length;
  await assert.rejects(claude.relay.action('B', { type: 'approval', requestId: 'approve-A', decision: 'allow' }));
  await assert.rejects(claude.relay.action('A', { type: 'approval', requestId: 'old', decision: 'allow' })); assert.equal(calls.length, count);
});
await test('允许一次只传原生 once，不修改全局权限', async () => {
  await claude.relay.action('A', { type: 'approval', requestId: 'approve-A', decision: 'allow' }); assert.deepEqual(calls.at(-1), ['approve', 'approve-A', 'once']);
});
await test('需桌面确认的审批不能由手机放行', async () => {
  sessions.A.pendingToolPermissions[0].requestId = 'protected-A';
  sessions.A.pendingToolPermissions[0].requiresUserInteraction = true;
  await assert.rejects(claude.relay.action('A', { type: 'approval', requestId: 'protected-A', decision: 'allow' }));
  await claude.relay.action('A', { type: 'approval', requestId: 'protected-A', decision: 'deny' }); assert.equal(calls.at(-1)[2], 'deny');
});
await test('并发重复点击只发送一次审批', async () => {
  sessions.A.pendingToolPermissions = [{ requestId: 'concurrent-A', toolName: 'Bash', input: { command: 'npm test' } }];
  const count = calls.length;
  const results = await Promise.allSettled([1, 2].map(() => claude.relay.action('A', { type: 'approval', requestId: 'concurrent-A', decision: 'allow' })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(calls.length, count + 1);
});
await test('旧一轮的停止操作不能停止新一轮', async () => {
  await assert.rejects(claude.relay.action('A', { type: 'interrupt', turnKey: 'old-turn' }));
  await claude.relay.action('A', { type: 'interrupt', turnKey: '123' }); assert.deepEqual(calls.at(-1), ['interrupt', 'A']);
});
await test('没有后台工作时不把历史任务显示为可停止', async () => {
  sessions.A.hasBackgroundWork = false; assert.equal((await claude.relay.snapshot('A')).tasks[0].canStop, false);
});
const sent = []; let codex;
codex = harness({ electronBridge: { windowType: 'electron', sendMessageFromView: async message => {
  sent.push(message);
  if (message.type === 'mcp-request') queueMicrotask(() => codex.emit({ type: 'mcp-response', hostId: 'local', message: { id: message.request.id, result: message.request.method === 'thread/turns/list' ? { data: [{ id: 'turn-A', status: 'inProgress' }] } : {} } }));
} } });
await test('Codex 中断携带真实当前 threadId 和 turnId', async () => {
  await codex.relay.action('thread-A', { type: 'interrupt', turnKey: 'turn-A' });
  const request = sent.find(s => s.request?.method === 'turn/interrupt'); assert.equal(request.request.params.threadId, 'thread-A'); assert.equal(request.request.params.turnId, 'turn-A');
  assert.ok(!sent.some(s => /resume|start/.test(s.request?.method || '')));
});
await test('Codex 原生审批保留 requestId 类型且不串会话', async () => {
  codex.emit({ type: 'mcp-request', hostId: 'local', request: { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-A', turnId: 'turn-A', command: 'npm test', reason: '运行检查' } } });
  assert.equal((await codex.relay.snapshot('thread-B')).approvals.length, 0);
  await codex.relay.action('thread-A', { type: 'approval', requestId: '7', decision: 'allow' });
  const response = sent.find(s => s.type === 'mcp-response'); assert.equal(response.response.id, 7); assert.equal(response.response.result.decision, 'accept'); assert.equal(response.threadId, 'thread-A');
  codex.emit({ type: 'mcp-notification', hostId: 'local', method: 'serverRequest/resolved', params: { requestId: 7 } });
  await assert.rejects(codex.relay.action('thread-A', { type: 'approval', requestId: '7', decision: 'allow' }));
});
await test('重复加载控制层不重复监听', async () => {
  vm.runInContext(source, claude.context); assert.equal(events.length, 1);
});
await test('拒绝任意控制方法', async () => { await assert.rejects(codex.relay.action('thread-A', { type: 'eval', expression: 'bad' })); });
console.log(`${passed} 项桌面控制用例通过`);
