import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(path.join(root,'server/package.json'));
const [major,minor]=process.versions.node.split('.').map(Number);
const checks=[{name:'Node.js 24.14+',ok:major===24&&minor>=14,required:true},{name:'Windows desktop backend',ok:process.platform==='win32',required:true}];
try{require.resolve('fastify');checks.push({name:'Backend dependencies',ok:true,required:true});}catch{checks.push({name:'Backend dependencies (run setup.cmd)',ok:false,required:true});}
checks.push({name:'Bundled bridge license',ok:fs.existsSync(path.join(root,'server/vendor/desktop-bridge/LICENSE')),required:true});
const pwsh=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command','exit 0'],{stdio:'ignore',windowsHide:true,timeout:5000});
checks.push({name:'PowerShell 7 (terminal tab)',ok:pwsh.status===0,required:false});
checks.push({name:'Local connection config',ok:fs.existsSync(path.join(root,'deploy/config.local.ps1')),required:false});
if(process.argv.includes('--json'))console.log(JSON.stringify({ready:checks.filter(c=>c.required).every(c=>c.ok),checks}));
else for(const check of checks)console.log(`${check.ok?'OK':'--'} ${check.name}${check.required?'':' [optional]'}`);
process.exitCode=checks.some(c=>c.required&&!c.ok)?1:0;
