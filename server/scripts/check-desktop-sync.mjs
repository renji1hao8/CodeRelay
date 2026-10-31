import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDeliveryTable, deliverOnce } from '../src/desktop/delivery.ts';
import { codexMessages, codexSummary } from '../src/desktop/mapping.ts';
import { unwrap, rpc } from '../src/desktop/native.ts';
import { parseQuota } from '../src/accounts/quota.ts';
import { spendingOf } from '../src/accounts/service.ts';

const request = { requestId: 'mobile_durable_message_01', deviceId: 'device-a', target: 'codex:thread-a', text: '继续' };
function ledger() { const db = new DatabaseSync(':memory:'); createDeliveryTable(db); return db; }
test('parallel retries cause one native write, including an in-flight acknowledgement', async () => {
  const db = ledger(); let calls = 0, finish;
  const send = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = deliverOnce(db, request, send);
  const second = await deliverOnce(db, request, send);
  assert.equal(second.status, 'unknown'); assert.equal(calls, 1);
  finish(); assert.equal((await first).status, 'submitted');
  assert.equal((await deliverOnce(db, request, send)).status, 'submitted'); assert.equal(calls, 1);
  db.close();
});
test('uncertain transport failure stays uncertain and is never retried', async () => {
  const db = ledger(); let calls = 0;
  const send = async () => { calls++; throw new Error('socket ended after write'); };
  assert.equal((await deliverOnce(db, request, send)).status, 'unknown');
  assert.equal((await deliverOnce(db, request, send)).status, 'unknown');
  assert.equal(calls, 1); db.close();
});
test('same id cannot cross devices, recipients or message text', async () => {
  const db = ledger(); await deliverOnce(db, request, async () => {});
  for (const change of [{deviceId:'device-b'}, {target:'codex:other'}, {text:'different'}])
    await assert.rejects(deliverOnce(db, {...request,...change}, async () => assert.fail('must not send')), /消息标识/);
  db.close();
});
test('persisted unacknowledged intent is not executed after server restart', async () => {
  const db = ledger();
  await deliverOnce(db, request, async () => { throw new Error('server died'); });
  createDeliveryTable(db);
  await deliverOnce(db, request, async () => assert.fail('must not send'));
  db.close();
});
test('desktop turns retain stable identities and map command output', () => {
  const turns = [{id:'turn-a',startedAt:1793414149,items:[
    {type:'userMessage',id:'user',content:[{type:'text',text:'hello'}]},
    {type:'agentMessage',id:'assistant',text:'working'},
    {type:'commandExecution',id:'cmd',command:'pwd',status:'completed',exitCode:0,output:{text:'workspace'}},
  ]}];
  const result = codexMessages(turns);
  assert.deepEqual(result.map(m=>m.role), ['user','assistant']);
  assert.equal(result[1].blocks.find(b=>b.type==='tool_result').text, 'workspace');
  turns[0].items[1].text = 'updated';
  const update = codexMessages(turns); assert.equal(update[1].uuid,result[1].uuid);
  assert.equal(update[1].blocks[0].text,'updated');
  assert.equal(codexSummary({id:'x',status:{type:'active'}}).status,'busy');
});
test('native RPC forbids non-local pipe paths and reports rejected tool results', async () => {
  assert.throws(()=>rpc('\\\\remote-host\\pipe\\foo','tools/list',{}), /地址无效/);
  assert.throws(()=>unwrap({success:false,contentItems:[]}), /操作失败/);
});
test('OpenCode Go shows remaining quota and hides placeholder resets for empty windows', () => {
  const rows = parseQuota('opencode_go',{usage:{rolling:{percent:37,resetsAt:'2026-11-01T00:00:00Z'},weekly:{percent:0,resetsAt:'2026-11-02T00:00:00Z'},monthly:{percent:100}}});
  assert.equal(rows.length,3); assert.equal(rows[0].remainingPercent,63);
  assert.equal(rows[1].resetsAt,null); assert.equal(rows[2].remainingPercent,0);
  assert.deepEqual(parseQuota('opencode_go',{usage:{rolling:{status:'unavailable'}}}),[]);
});
test('Codex windows keep fractional usage and zero usage does not imply reset countdown', () => {
  const rows = parseQuota('codex',{rate_limit:{primary_window:{used_percent:0.4,limit_window_seconds:18000,reset_at:1793420000},secondary_window:{used_percent:0,limit_window_seconds:604800,reset_at:1793420000}}});
  assert.equal(rows[0].remainingPercent,99.6); assert.equal(rows[1].resetsAt,null);
});
test('provider balances preserve currency and do not invent missing amounts', () => {
  const rows = parseQuota('custom',[{planName:'wallet',remaining:12.5,unit:'CNY'},{planName:'unlimited'}]);
  assert.equal(rows[0].remaining,12.5); assert.equal(rows[0].unit,'CNY');
  assert.equal(rows[1].remaining,undefined); assert.equal(rows[1].remainingPercent,undefined);
  assert.throws(()=>parseQuota('custom',{isValid:false}),/不可用/);
});
test('cc-switch recorded spending accepts an explicit timezone and reads numeric cost strings', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE providers(id TEXT,app_type TEXT,name TEXT);
    CREATE TABLE proxy_request_logs(provider_id TEXT,app_type TEXT,created_at INTEGER,total_cost_usd TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_creation_tokens INTEGER);
    INSERT INTO providers VALUES('p','claude','provider');`);
  const insert = db.prepare('INSERT INTO proxy_request_logs VALUES(?,?,?,?,?,?,?,?)');
  insert.run('p','claude',Date.parse('2026-10-30T16:01:00Z')/1000,'1.25',10,2,3,4);
  insert.run('p','claude',Date.parse('2026-10-30T15:59:00Z')/1000,'2.50',1,1,1,1);
  const result=spendingOf(db,Date.parse('2026-10-31T02:00:00Z'),480);
  assert.equal(result.todayUsd,1.25); assert.equal(result.monthUsd,3.75);
  assert.equal(result.requests,1); assert.equal(result.tokens,19); assert.equal(result.byProvider[0].costUsd,1.25);
  assert.equal(spendingOf(db,Date.parse('2026-10-31T02:00:00Z'),0).todayUsd,0);
  db.close();
});
