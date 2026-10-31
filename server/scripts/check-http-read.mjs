// Isolated backend, real read-only Desktop transport, no model turns.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const temporary=await mkdtemp(join(tmpdir(),'remotecc-http-test-'));
const data=join(temporary,'data');await mkdir(data);
const ccPath=join(temporary,'cc-switch.db');
const cc=new DatabaseSync(ccPath);
cc.exec('CREATE TABLE providers(id TEXT,app_type TEXT,name TEXT,settings_config TEXT,meta TEXT,is_current INTEGER,category TEXT)');cc.close();
const child=spawn(process.execPath,['server/src/index.ts'],{cwd:resolve(import.meta.dirname,'../..'),windowsHide:true,
  env:{...process.env,REMOTE_CC_PORT:'0',REMOTE_CC_DATA_DIR:data,REMOTE_CC_CCSWITCH_DB:ccPath},stdio:['ignore','pipe','pipe']});
let port,logs='';
child.stdout.on('data',b=>{logs+=b;const match=/Server listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(logs);if(match)port=Number(match[1]);});
child.stderr.on('data',b=>{logs+=b;});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
  const deadline=Date.now()+15000;
  while(!port&&Date.now()<deadline&&child.exitCode===null)await wait(100);
  if(!port) console.error(logs.replace(/Bearer [^\s]+/g,'Bearer [hidden]').slice(-2500));
  assert.ok(port,'isolated backend must start');
  const base=`http://127.0.0.1:${port}`;
  const token=randomUUID(),db=new DatabaseSync(join(data,'remote-cc.db'));
  db.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)').run('test-device','isolated test',createHash('sha256').update(token).digest('hex'),new Date().toISOString());db.close();
  for(const route of ['/api/accounts','/api/terminal','/api/desktop/codex/sessions','/api/desktop/codex/sessions/any/control','/api/desktop/claude/sessions/any/tasks/any/output'])assert.equal((await fetch(base+route)).status,401);
  const headers={authorization:`Bearer ${token}`};
  const started=Date.now();await Promise.all(Array.from({length:6},async()=>assert.equal((await fetch(base+'/api/health')).status,200)));
  console.log('parallel health',Date.now()-started,'ms');
  const accountResponse=await fetch(base+'/api/accounts',{headers});assert.equal(accountResponse.status,200);
  const accounts=await accountResponse.json();assert.equal(accounts.providers.length,0);assert.equal(accounts.spending.available,false);
  const listed=await fetch(base+'/api/desktop/codex/sessions',{headers});assert.equal(listed.status,200);
  const page=await listed.json();assert.ok(page.sessions.length);
  const targetId=process.argv[2]||page.sessions[0].id;
  const read=await fetch(base+'/api/desktop/codex/sessions/'+targetId,{headers});
  if(read.status!==200)console.error('desktop read error',String(await read.clone().text()).slice(0,500));
  assert.equal(read.status,200);
  const detail=await read.json();assert.ok(Array.isArray(detail.messages));assert.ok(detail.messages.length>0,'known nonempty desktop history must render messages');
  const controlRoute=base+'/api/desktop/codex/sessions/'+page.sessions[0].id+'/control';
  const control=await fetch(controlRoute,{headers});assert.equal(control.status,200);assert.equal((await control.json()).connected,false);
  const badControl=await fetch(controlRoute,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({type:'eval',expression:'not executable'})});assert.equal(badControl.status,400);
  const unauthControl=await fetch(controlRoute,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'interrupt',turnKey:'any'})});assert.equal(unauthControl.status,401);
  const invalid=await fetch(base+'/api/desktop/codex/sessions/'+page.sessions[0].id+'/messages',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({text:'not sent',requestId:'bad'})});assert.equal(invalid.status,400);
  const openRoute=base+'/api/desktop/codex/sessions/'+page.sessions[0].id+'/open';
  assert.equal((await fetch(openRoute,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(openRoute,{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'})).status,400);
  assert.equal((await fetch(base+'/api/sessions/nonexistent/resume',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'})).status,404);
  console.log('HTTP integration passed: auth, health, accounts, desktop list/history, invalid-send rejection, implicit CLI rejection');
} finally {
  if(child.exitCode===null && child.signalCode===null){
    const exited=once(child,'exit');child.kill('SIGTERM');
    await Promise.race([exited,wait(5000)]);
    if(child.exitCode===null && child.signalCode===null){child.kill('SIGKILL');await exited;}
  }
  const root=resolve(tmpdir()),target=resolve(temporary);
  if(dirname(target)!==root||!basename(target).startsWith('remotecc-http-test-'))throw new Error('unexpected fixture directory');
  await rm(target,{recursive:true,force:true});
}
