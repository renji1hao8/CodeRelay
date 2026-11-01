import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {claudeWriterConflict,claudeDesktopBinding} from '../src/desktop/claude-sessions.ts';
import {sendNative} from '../src/desktop/native.ts';
const source=fs.readFileSync(new URL('../src/desktop/claude-activation.js',import.meta.url),'utf8');
const identity={id:'original',cwd:'E:\\Project',modifiedAt:100,uuids:['a','b']};
function fixture({existing=[],rows=[{handle:'opaque',cwd:'E:\\Project',lastActivityAt:100}],resumable=true,transcript=[{uuid:'a'},{uuid:'b'}]}={}){
 const calls=[];const api={getAll:async()=>existing,getSession:async id=>({sessionId:id,cwd:identity.cwd,status:'idle'}),getTranscriptTail:async()=>({messages:transcript}),
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
{
 const hostId='local_00000000-0000-4000-8000-000000000001';
 const record={sessionId:'original',hostSessionId:hostId,cwd:identity.cwd,pid:123,procStart:'start-a',pidDomain:'windows',entrypoint:'claude-desktop-3p'};
 const binding=claudeDesktopBinding('original',[record],()=>record);
 assert.equal(binding.hostSessionId,hostId);
 const f=fixture();
 await f.remote.verify(hostId,identity,binding.hostSessionId);
 assert.equal(f.calls.length,0,'preflight must not send or wake an agent');
 await f.remote.send(hostId,identity,'start while idle','message-id',binding.hostSessionId);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'send');assert.equal(f.calls[0][1],hostId);
 await assert.rejects(f.remote.send('local_fork',identity,'wrong host','id',hostId),/标识/);
 assert.throws(()=>claudeDesktopBinding('original',[record,{...record,sessionId:'other'}],()=>record),/唯一核实/);
 assert.throws(()=>claudeDesktopBinding('original',[record,record],()=>record),/唯一核实/);
 assert.throws(()=>claudeDesktopBinding('original',[{...record,entrypoint:'cli'}],()=>record),/唯一核实/);
 assert.throws(()=>claudeDesktopBinding('original',[record],()=>({...record,sessionId:'other'})),/归属已变化/);
 assert.throws(()=>claudeDesktopBinding('original',[record],()=>({...record,hostSessionId:'local_fork'})),/归属已变化/);
 assert.throws(()=>claudeDesktopBinding('original',[record],()=>{throw new Error('process identity mismatch');}),/identity mismatch/);
 const wrongHistory=fixture({transcript:[{uuid:'fork-a'},{uuid:'fork-b'}]});
 await assert.rejects(wrongHistory.remote.send(hostId,identity,'wrong history','id',hostId),/原始历史/);
 assert.equal(wrongHistory.calls.length,0);
 const wrongDirectory=fixture();wrongDirectory.api.getSession=async()=>({sessionId:hostId,cwd:'E:/other'});
 await assert.rejects(wrongDirectory.remote.send(hostId,identity,'wrong directory','id',hostId),/归属已变化/);
 assert.equal(wrongDirectory.calls.length,0);
 f.api.sendMessage=async()=>{throw new Error('undelivered');};
 await assert.rejects(f.remote.send(hostId,identity,'rejected','id',hostId),/undelivered/);
}
await assert.rejects(sendNative('claude','original','must not enqueue','request-id'),/桌面输入接口/);
console.log('OK idle desktop sends, registry-authorized live host binding, no inbox fallback, transcript/directory guards, native rejection and single resume');
