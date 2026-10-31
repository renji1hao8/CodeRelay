import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

const temporary = await mkdtemp(join(tmpdir(), 'remotecc-history-test-'));
const project = join(temporary,'projects','project-a');
await mkdir(project,{recursive:true});
process.env.REMOTE_CC_DATA_DIR=join(temporary,'data');
process.env.REMOTE_CC_CLAUDE_PROJECTS_DIR=join(temporary,'projects');
const { parseSession }=await import('../src/history/parser.ts');
const { historyRequest,stopHistoryWorker }=await import('../src/history/desktop-client.ts');
const id='00000000-0000-4000-8000-000000000001';
const file=join(project,id+'.jsonl');
const entry=(uuid,text)=>JSON.stringify({type:'user',sessionId:id,uuid,timestamp:'2026-10-31T02:00:00Z',cwd:'E:\\example',message:{role:'user',content:text}})+'\n';
test('incremental transcript reads preserve byte offsets, partial records and rewrite detection',async()=>{
  const first=entry('user-a','中文第一条');
  await writeFile(file,first);
  const a=parseSession(file);assert.equal(a.messages.length,1);assert.equal(a.nextOffset,Buffer.byteLength(first));
  const second=entry('user-b','中文第二条');
  await appendFile(file,second.slice(0,-1));
  const partial=parseSession(file,a.nextOffset);assert.equal(partial.messages.length,0);assert.equal(partial.nextOffset,a.nextOffset);
  await appendFile(file,'\n');
  const b=parseSession(file,a.nextOffset);assert.equal(b.messages[0].uuid,'user-b');assert.equal(b.nextOffset,Buffer.byteLength(first+second));
  await writeFile(file,entry('user-c','重写'));
  const c=parseSession(file,b.nextOffset);assert.equal(c.reset,true);assert.equal(c.messages[0].uuid,'user-c');
});
test('worker indexes a transcript and follows new messages without blocking the main event loop',async()=>{
  await writeFile(file,Array.from({length:100},(_,i)=>entry('message-'+i,'消息 '+i)).join(''));
  let heartbeats=0;const heartbeat=setInterval(()=>heartbeats++,1);
  try {
    const list=await historyRequest('sessions');assert.equal(list[0].id,id);
    assert.ok(heartbeats>0,'main event loop must remain available during indexing');
    const latest=await historyRequest('detail',id);assert.equal(latest.messages.length,80);assert.ok(latest.olderCursor);
    const older=await historyRequest('detail',id,latest.olderCursor);assert.equal(older.messages.length,20);assert.equal(older.olderCursor,null);
    await appendFile(file,entry('message-new','最新消息'));
    const updated=await historyRequest('detail',id);assert.equal(updated.messages.at(-1).uuid,'message-new');
    assert.equal(new Set(updated.messages.map(m=>m.uuid)).size,updated.messages.length);
  } finally {clearInterval(heartbeat);}
});
test.after(async()=>{
  await stopHistoryWorker();
  // Only remove the exact randomly-created fixture directory under OS temp.
  const root=resolve(tmpdir()),target=resolve(temporary);
  if (dirname(target)!==root || !basename(target).startsWith('remotecc-history-test-')) throw new Error('unexpected fixture path');
  // Main-thread parser imported db.ts as well; close its fixture-only handle.
  const { db }=await import('../src/db.ts');db.close();
  await rm(target,{recursive:true,force:true});
});
