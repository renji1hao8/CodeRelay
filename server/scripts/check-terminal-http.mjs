import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
const root=await mkdtemp(path.join(tmpdir(),'remotecc-terminal-http-'));
process.env.REMOTE_CC_DATA_DIR=path.join(root,'data');
const {terminalRoutes}=await import('../src/routes/terminal.ts');
const {requireDevice}=await import('../src/auth.ts');
const {db}=await import('../src/db.ts');
const app=Fastify({logger:false});await app.register(websocket);app.addHook('onRequest',requireDevice);await app.register(terminalRoutes);
const tokens=[randomUUID(),randomUUID()];
for(let i=0;i<tokens.length;i++)db.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)').run('D'+i,'fixture',createHash('sha256').update(tokens[i]).digest('hex'),new Date().toISOString());
const sockets=[];
async function connect(base,index){const ws=new WebSocket(base+'?token='+encodeURIComponent(tokens[index]));sockets.push(ws);const frames=[];ws.addEventListener('message',event=>frames.push(JSON.parse(event.data)));await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});return {ws,frames};}
const send=(peer,frame)=>peer.ws.send(JSON.stringify(frame));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function frame(peer,t,after=0){const deadline=Date.now()+15000;while(Date.now()<deadline){const found=peer.frames.slice(after).find(f=>f.t===t);if(found)return found;await wait(30);}throw Error('missing '+t);}
async function snapshot(peer){const after=peer.frames.length;send(peer,{t:'terminal_open',cols:70,rows:20});return frame(peer,'terminal_state',after);}
try{
 await app.listen({port:0,host:'127.0.0.1'});const port=app.server.address().port;
 assert.equal((await fetch('http://127.0.0.1:'+port+'/api/terminal')).status,401);
 const base='ws://127.0.0.1:'+port+'/api/terminal',a=await connect(base,0),b=await connect(base,1);
 const first=await snapshot(a);assert.ok(first.id);const stateB=await snapshot(b);assert.notEqual(first.id,stateB.id);
 const before=b.frames.length;send(b,{t:'terminal_input',id:first.id,data:'not executed\r'});assert.match((await frame(b,'terminal_error',before)).message,/连接已变化/);
 console.log('OK websocket authentication and device/session isolation');
 send(a,{t:'terminal_input',id:first.id,data:"$remoteccHttpProbe=73;Write-Output ('WS_'+'READY')\r"});
 let state;const deadline=Date.now()+15000;while(Date.now()<deadline){state=await snapshot(a);if(state.screen.includes('WS_READY'))break;await wait(100);}assert.ok(state.screen.includes('WS_READY'));
 a.ws.close();await wait(150);
 const resumed=await connect(base,0),restored=await snapshot(resumed);assert.equal(restored.id,first.id);assert.ok(restored.screen.includes('WS_READY'));
 send(resumed,{t:'terminal_input',id:restored.id,data:"Write-Output ('VALUE_'+$remoteccHttpProbe)\r"});
 const limit=Date.now()+10000;while(Date.now()<limit){state=await snapshot(resumed);if(state.screen.includes('VALUE_73'))break;await wait(80);}assert.ok(state.screen.includes('VALUE_73'));
 console.log('OK reconnect reattaches the same pwsh with state and screen intact');
 const after=resumed.frames.length;send(resumed,{t:'terminal_open',cols:70,rows:20,fresh:true});const fresh=await frame(resumed,'terminal_state',after);assert.notEqual(fresh.id,first.id);assert.equal((await snapshot(b)).id,stateB.id);
 console.log('OK explicit new terminal replaces only the caller device terminal');
}finally{
 for(const socket of sockets)socket.close();await wait(100);await app.close();db.close();
 const target=path.resolve(root),base=path.resolve(tmpdir());if(path.dirname(target)!==base||!path.basename(target).startsWith('remotecc-terminal-http-'))throw Error('unsafe fixture root');await rm(target,{recursive:true,force:true});
}
