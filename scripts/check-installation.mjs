import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const source=path.resolve(process.argv[2]||'dist/remotecc-1.0.0/windows');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'remotecc-install-'));
const fixture=path.join(temp,"Fresh 安装's directory");let backendPid;
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('REMOTE_CC_'))delete env[key];
const run=(file,args=[])=>{const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(fixture,file),...args],{cwd:fixture,env,encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(result.status,0,`${file} failed (logs withheld; may include pairing data)`);return result.stdout;};
try{
 fs.cpSync(source,fixture,{recursive:true});
 assert.equal(fs.existsSync(path.join(fixture,'server/node_modules/@anthropic-ai/claude-agent-sdk')),false);
 const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const folder=path.join(fixture,"My project's files");fs.mkdirSync(folder);
 run('scripts/setup.ps1',['-SkipDependencies','-Connection','Tunnel','-ServerUrl',`http://127.0.0.1:${port}`,'-Folders',folder]);
 const config=path.join(fixture,'deploy/config.local.ps1'),before=fs.readFileSync(config,'utf8');
 assert.ok(before.includes("$ListenHost='127.0.0.1'"));assert.ok(before.includes("project''s"));
 run('scripts/setup.ps1',['-SkipDependencies','-Connection','LAN','-ServerUrl','http://example.invalid','-Folders',folder]);assert.equal(fs.readFileSync(config,'utf8'),before);
 fs.appendFileSync(config,`\n$BackendPort=${port}\n`);
 run('deploy/start.ps1',['-NoPair']);
 backendPid=Number(fs.readFileSync(path.join(fixture,'server/data/backend.pid'),'utf8'));assert.ok(backendPid>0);
 const health=await(await fetch(`http://127.0.0.1:${port}/api/health`)).json();assert.equal(health.version,'1.0.0');
 const pairing=run('deploy/pair.ps1');assert.match(pairing,/\d{6}/);
 const password=fs.readFileSync(path.join(fixture,'server/data/pair-password.txt'),'utf8').trim();
 const begin=await(await fetch(`http://127.0.0.1:${port}/api/pair/start`,{method:'POST',headers:{'x-remote-cc-pair-password':password}})).json();
 const device=await(await fetch(`http://127.0.0.1:${port}/api/pair/claim`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:begin.code,deviceName:'Installer fixture'})})).json();assert.ok(device.token);
 const roots=await(await fetch(`http://127.0.0.1:${port}/api/fs/roots`,{headers:{authorization:`Bearer ${device.token}`}})).json();assert.ok(roots.roots.some(item=>item.path===folder),'Configured Unicode project folder must reach the backend unchanged');
 console.log('OK extracted portable runtime, fresh wizard, apostrophe/Unicode paths, config preservation, hidden backend startup and pairing helper');
}finally{
 if(!backendPid){try{backendPid=Number(fs.readFileSync(path.join(fixture,'server/data/backend.pid'),'utf8'));}catch{}}
 if(backendPid){try{process.kill(backendPid);}catch{}}
 await new Promise(r=>setTimeout(r,300));
 fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:150});
}
