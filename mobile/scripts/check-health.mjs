import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../src/api.ts';
test('parallel health probes share one request and complete without loading providers',async()=>{
  const previous=globalThis.fetch; let calls=0,resolve;
  globalThis.fetch=()=>{ calls++; return new Promise(r=>{resolve=r;}); };
  try {
    const api=new Api({baseUrl:'https://example.invalid',token:'paired'});
    const a=api.health(),b=api.health(); assert.equal(a,b); assert.equal(calls,1);
    resolve(new Response(JSON.stringify({version:'test'}))); assert.equal((await a).version,'test');
    const c=api.health(); assert.equal(calls,2); resolve(new Response('{}')); await c;
  } finally {globalThis.fetch=previous;}
});
test('health timeout has a single four-second budget and no GET retry chain',async t=>{
  const previous=globalThis.fetch; let calls=0;
  t.mock.timers.enable({apis:['setTimeout']});
  globalThis.fetch=(_url,{signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));};
  try {
    const api=new Api({baseUrl:'https://example.invalid',token:'paired'});
    const check=assert.rejects(api.health(),/4 秒/); t.mock.timers.tick(4000); await check; assert.equal(calls,1);
  } finally {globalThis.fetch=previous;t.mock.timers.reset();}
});
test('desktop sends never retry a failed POST',async()=>{
  const previous=globalThis.fetch; let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('connection lost after write');};
  try {
    const api=new Api({baseUrl:'https://example.invalid',token:'paired'});
    await assert.rejects(api.desktopSend('codex','id','hello','mobile_message_id'));assert.equal(calls,1);
  } finally {globalThis.fetch=previous;}
});
