import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'remotecc-public-'));
const root=path.resolve(process.env.REMOTE_CC_TEST_ROOT||path.resolve(import.meta.dirname,'../..'));
let output='';
const executable=fs.existsSync(path.join(root,'runtime/node.exe'))?path.join(root,'runtime/node.exe'):process.execPath;
const child=spawn(executable,[path.join(root,'server/src/index.ts')],{cwd:root,windowsHide:true,env:{...process.env,REMOTE_CC_DATA_DIR:temp,REMOTE_CC_PORT:'0',REMOTE_CC_LISTEN_HOST:'127.0.0.1',REMOTE_CC_ROOTS:'',REMOTE_CC_LIST_DIR:path.join(temp,'list'),REMOTE_CC_ENABLE_ACCOUNTS:'0',REMOTE_CC_ENABLE_ELEVATION:'0',REMOTE_CC_ENABLE_WEBDAV:'0',REMOTE_CC_ENABLE_LEGACY_CLI:'0'}});
child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
try{
 const deadline=Date.now()+20000;let address;
 while(Date.now()<deadline){address=output.match(/Server listening at http:\/\/127\.0\.0\.1:(\d+)/)?.[1];if(address)break;if(child.exitCode!==null)throw Error('Isolated backend failed to start');await new Promise(r=>setTimeout(r,100));}
 assert.ok(address,'Isolated backend must listen');
 const base=`http://127.0.0.1:${address}`;
 const request=(route,options={})=>fetch(base+route,options);
 assert.equal((await request('/api/health')).status,200);
 assert.equal((await request('/api/fs/roots')).status,401);
 assert.equal((await request('/api/pair/start',{method:'POST'})).status,403);
 const password=fs.readFileSync(path.join(temp,'pair-password.txt'),'utf8').trim();
 const started=await request('/api/pair/start',{method:'POST',headers:{'x-remote-cc-pair-password':password}});assert.equal(started.status,200);
 const {code}=await started.json();
 const claim=await request('/api/pair/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,deviceName:'Isolated test'})});assert.equal(claim.status,200);
 const {token}=await claim.json();assert.ok(token);
 const auth={headers:{authorization:`Bearer ${token}`}};
 const roots=await(await request('/api/fs/roots',auth)).json();assert.deepEqual(roots.roots.map(r=>r.path),[path.join(temp,'list')]);
 assert.equal((await request('/api/fs/read?path='+encodeURIComponent(path.join(root,'package.json')),auth)).status,403);
 assert.equal((await request('/api/sessions',auth)).status,404);
 assert.equal((await request('/dav/',auth)).status,404);
 const accounts=await request('/api/accounts',auth);assert.equal(accounts.status,200);assert.deepEqual((await accounts.json()).providers,[]);
 console.log('OK clean startup, pairing, device auth, restricted roots and disabled integrations');
}catch(error){console.error('Isolated backend check failed; captured logs are withheld to avoid printing pairing data.');throw error;}
finally{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));fs.rmSync(temp,{recursive:true,force:true});}
