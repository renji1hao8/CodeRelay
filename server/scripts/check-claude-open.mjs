import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {claudeWriterConflict} from '../src/desktop/claude-sessions.ts';
const source=fs.readFileSync(new URL('../src/desktop/claude-activation.js',import.meta.url),'utf8');
const identity={id:'original',cwd:'E:\\Project',modifiedAt:100,uuids:['a','b']};
function fixture({existing=[],rows=[{handle:'opaque',cwd:'E:\\Project',lastActivityAt:100}],resumable=true,transcript=[{uuid:'a'},{uuid:'b'}]}={}){
 const calls=[];const api={getAll:async()=>existing,getSession:async id=>({sessionId:id,cwd:identity.cwd}),getTranscriptTail:async()=>({messages:transcript}),
 listResumableCliSessions:async()=>rows,readCliTranscript:async()=>({messages:transcript,totalMessages:2}),previewCliResume:async()=>({resumable,reason:'untrusted'}),
 resumeCliSession:async handle=>{calls.push(['resume',handle]);return {ok:true,sessionId:'local_original'};},warmSession:async id=>calls.push(['warm',id]),sendMessage:async(...args)=>calls.push(['send',...args])};
 const ctx={'claude.web':{LocalSessions:api},Map,Set};vm.runInNewContext(source,ctx);return {api,remote:ctx.__remoteccClaudeActivation,calls};
}
{
 const f=fixture();const results=await Promise.all([f.remote.open(identity),f.remote.open(identity)]);
 assert.equal(results[0].hostId,'local_original');assert.equal(f.calls.filter(c=>c[0]==='resume').length,1);
 await f.remote.send('local_original',identity,'continue','message-id');const send=f.calls.find(c=>c[0]==='send').slice(1);
 assert.equal(send.length,15);assert.equal(send[0],'local_original');assert.equal(send[1],'continue');assert.equal(send[7],'message-id');assert.equal(send[14].rejectUndelivered,true);
 assert.ok(send.slice(2,7).every(v=>v===undefined));
}
{
 const f=fixture({existing:[{sessionId:'local_original',cwd:identity.cwd}]});assert.equal((await f.remote.open(identity)).hostId,'local_original');assert.equal(f.calls.some(c=>c[0]==='resume'),false);
}
await assert.rejects(fixture({resumable:false}).remote.open(identity),/信任/);
await assert.rejects(fixture({transcript:[{uuid:'wrong'},{uuid:'history'}]}).remote.open(identity),/唯一恢复入口/);
await assert.rejects(fixture({rows:[{handle:'wrong',cwd:'E:\\Other',lastActivityAt:100}]}).remote.open(identity),/唯一恢复入口/);
const forks=fixture({existing:[{sessionId:'local_fork',cwd:identity.cwd}]});assert.equal((await forks.remote.open(identity)).hostId,'local_original');assert.equal(forks.calls.find(c=>c[0]==='warm')[1],'local_original');
await assert.rejects(forks.remote.send('local_fork',identity,'no','id'),/标识与原历史不一致/);
assert.equal(claudeWriterConflict('original',[{sessionId:'original',entrypoint:'cli'}]),true);
assert.equal(claudeWriterConflict('original',[{sessionId:'other',hostSessionId:'host',entrypoint:'claude-desktop'}],'host'),true);
console.log('OK exact transcript binding, single resume under concurrency, existing host reuse, trust refusal and writer conflicts');
