import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {pruneRuntime} from './prune-runtime.mjs';
import {root,version,releaseRoot} from './export-public-source.mjs';
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Package on Windows x64');
const destination=path.join(releaseRoot,'windows');
if(fs.existsSync(destination))throw Error('Windows output already exists; move it aside before rebuilding');
fs.mkdirSync(destination,{recursive:true});
const copy=(name,to=name)=>fs.cpSync(path.join(root,name),path.join(destination,to),{recursive:true});
for(const file of ['README.md','LICENSE','THIRD_PARTY_NOTICES.md','SECURITY.md','docs','integrations','setup.cmd','start.cmd','pair.cmd','doctor.cmd','desktop-control.cmd'])copy(file);
for(const file of ['config.ps1','config.example.ps1','start.ps1','pair.ps1','start-desktop-control.ps1','bootstrap.ps1','watchdog.ps1','register-tasks.ps1','run-hidden.vbs','rotate-logs.ps1','restart-backend.ps1','restart-backend-later.ps1','elevate.ps1','elevated-executor.ps1','install-elevated-executor.ps1','check-elevated-executor.ps1'])copy('deploy/'+file);
for(const file of ['setup.ps1','doctor.mjs'])copy('scripts/'+file);
copy('server/src');copy('server/vendor');copy('server/scripts/show-pair-info.mjs');copy('packages/shared','server/vendor/shared');
// Node's type stripping is intentionally disabled inside node_modules. Ship shared runtime JS.
const shared=path.join(destination,'server/vendor/shared');
for(const file of fs.readdirSync(path.join(shared,'src')).filter(f=>f.endsWith('.ts'))){const input=fs.readFileSync(path.join(shared,'src',file),'utf8');fs.writeFileSync(path.join(shared,'src',file.replace(/\.ts$/,'.js')),stripTypeScriptTypes(input).replace(/(from\s+["'][^"']+)\.ts(["'])/g,'$1.js$2'));}
const sharedPackage=JSON.parse(fs.readFileSync(path.join(shared,'package.json')));sharedPackage.main='./src/index.js';sharedPackage.exports={'.':'./src/index.js'};fs.writeFileSync(path.join(shared,'package.json'),JSON.stringify(sharedPackage,null,2)+'\n');
const locked=path.join(root,'release/runtime');
const hasLock=fs.existsSync(path.join(locked,'package-lock.json'))&&!process.argv.includes('--refresh-lock');
const source=JSON.parse(fs.readFileSync(path.join(root,'server/package.json')));
const deps={};if(!hasLock)for(const name of Object.keys(source.dependencies))deps[name]=name==='@remote-cc/shared'?'file:vendor/shared':JSON.parse(fs.readFileSync(path.join(root,'server/node_modules',name,'package.json'))).version;
const manifest=hasLock?JSON.parse(fs.readFileSync(path.join(locked,'package.json'))):{name:'remotecc-runtime',version,private:true,type:'module',license:'MIT',dependencies:deps};
if(manifest.version!==version)throw Error('Refresh the runtime lock after changing the release version');
fs.writeFileSync(path.join(destination,'server/package.json'),JSON.stringify(manifest,null,2)+'\n');
if(hasLock)fs.copyFileSync(path.join(locked,'package-lock.json'),path.join(destination,'server/package-lock.json'));
const npm=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`npm ${hasLock?'ci':'install'} --omit=dev --ignore-scripts --install-links --registry=https://registry.npmjs.org`],{cwd:path.join(destination,'server'),stdio:'inherit',windowsHide:true});
if(npm.status!==0)throw Error('Production dependency installation failed');
const ptyRoot=path.join(destination,'server/node_modules/node-pty');
for(const file of ['prebuild.js','post-install.js']){const result=spawnSync(process.execPath,[path.join(ptyRoot,'scripts',file)],{cwd:ptyRoot,stdio:'inherit',windowsHide:true});if(result.status!==0)throw Error('node-pty Windows prebuilt setup failed');}
pruneRuntime(path.join(destination,'server/node_modules'));
// Store the exact resolved runtime manifest for reproducible dependency review.
fs.mkdirSync(locked,{recursive:true});
for(const file of ['package.json','package-lock.json'])fs.copyFileSync(path.join(destination,'server',file),path.join(locked,file));
const runtime=spawnSync(process.execPath,['--use-env-proxy',path.join(root,'scripts/package-node-runtime.mjs'),path.join(destination,'runtime')],{stdio:'inherit',windowsHide:true});if(runtime.status!==0)throw Error('Node runtime verification failed');
console.log('Windows runtime ready; no workstation config or runtime data copied.');
