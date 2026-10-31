import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDesktopMessages, containsDesktopText, confirmsDesktopPending, withDesktopPending, findDesktopReceipt } from '../src/desktopState.ts';
const message=(uuid,text,role='assistant')=>({uuid,role,ts:null,blocks:[{type:'text',text}]});
test('new snapshot replaces growing message instead of duplicating it',()=>{
  const result=mergeDesktopMessages([message('a','first')],[message('a','first second')]);
  assert.equal(result.length,1); assert.equal(result[0].blocks[0].text,'first second');
});
test('history pagination prepends and deduplicates while preserving newer snapshots',()=>{
  const result=mergeDesktopMessages([message('b','new b'),message('c','c')],[message('a','a'),message('b','old b')],true);
  assert.deepEqual(result.map(m=>m.uuid),['a','b','c']); assert.equal(result[1].blocks[0].text,'new b');
});
test('peer envelope can confirm exact mobile text and assistant text cannot',()=>{
  assert.equal(containsDesktopText([message('a','<peer>hello</peer>','user')],'hello'),true);
  assert.equal(containsDesktopText([message('a','hello')],'hello'),false);
});
test('attachment presentation still acknowledges original wire text and image-only sends',()=>{
 const photo={uuid:'photo',role:'user',ts:'2026-10-31T01:00:01Z',blocks:[{type:'text',text:'请看这张图'},{type:'image',path:'E:/attachments/a.jpg',mediaType:'image/jpeg',size:100}]};
 assert.equal(containsDesktopText([photo],'请看这张图\n\n@E:/attachments/a.jpg'),true);
 assert.equal(containsDesktopText([photo],'@E:/attachments/a.jpg'),true);
 assert.equal(containsDesktopText([photo],'@E:/attachments/wrong.jpg'),false);
});
test('reopened snapshots follow source position even when flush timestamps disagree',()=>{
 const a={...message('a','question','user'),sequence:10,ts:'2026-10-31T01:00:03Z'};
 const b={...message('b','answer'),sequence:20,ts:'2026-10-31T01:00:01Z'};
 assert.deepEqual(mergeDesktopMessages([b],[a,b]).map(m=>m.uuid),['a','b']);
 assert.deepEqual(mergeDesktopMessages([b,a],[a,b]).map(m=>m.uuid),['a','b']);
});
test('optimistic user bubble stays before the answer and disappears once received',()=>{
 const pending={requestId:'pending',text:'continue',at:'2026-10-31T01:00:01Z'};
 const answer={...message('answer','working'),ts:'2026-10-31T01:00:02Z'};
 assert.deepEqual(withDesktopPending([answer],pending).map(m=>m.uuid),['pending','answer']);
 const received={...message('received','continue','user'),ts:pending.at};
 assert.equal(confirmsDesktopPending([received],pending),true);
 assert.deepEqual(withDesktopPending([received,answer],pending).map(m=>m.uuid),['received','answer']);
 assert.equal(confirmsDesktopPending([{...received,ts:'2026-10-30T01:00:01Z'},answer],pending),false);
});
test('stream completion replaces a partial message using the same stable item ID',()=>{
 const partial={...message('item-id','partial'),ts:'2026-10-31T01:00:02Z'};
 const complete={...partial,sequence:40,blocks:[{type:'text',text:'complete'}]};
 assert.deepEqual(mergeDesktopMessages([partial],[complete]),[complete]);
});
test('receipt check reads older pages when a long reply pushes the user out of the latest page',async()=>{
 const pending={text:'continue',at:'2026-10-31T01:00:01Z'};
 const first={messages:[{...message('answer','working'),ts:'2026-10-31T01:00:10Z'}],olderCursor:'older'};
 let calls=0;
 const result=await findDesktopReceipt(first,pending,async cursor=>{calls++;assert.equal(cursor,'older');return {messages:[{...message('received','continue','user'),ts:pending.at}],olderCursor:null};});
 assert.equal(result.received,true);assert.equal(calls,1);assert.deepEqual(result.messages.map(m=>m.uuid),['received','answer']);
 const old={messages:[{...message('old','continue','user'),ts:'2026-10-30T01:00:01Z'}],olderCursor:'older'};
 assert.equal((await findDesktopReceipt(old,pending,async()=>assert.fail('must stop before older unrelated history'))).received,false);
});
