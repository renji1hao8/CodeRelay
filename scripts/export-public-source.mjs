import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
export const root=path.resolve(import.meta.dirname,'..');
export const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
export const releaseRoot=path.join(root,'dist',`coderelay-${version}`);
const folders=['docs','integrations','scripts','deploy','release/runtime','server/src','server/scripts','server/vendor','packages/shared','mobile/src','mobile/scripts','mobile/assets','mobile/modules/remote-cc-notify','.github'];
const files=['README.md','LICENSE','SECURITY.md','CHANGELOG.md','CONTRIBUTING.md','THIRD_PARTY_NOTICES.md','AGENTS.md','CLAUDE.md','.gitignore','.npmrc','.env.example','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','setup.cmd','start.cmd','pair.cmd','doctor.cmd','desktop-control.cmd','server/package.json','server/tsconfig.json','server/CLAUDE.md','mobile/package.json','mobile/package-lock.json','mobile/app.json','mobile/index.ts','mobile/App.tsx','mobile/tsconfig.json','mobile/babel.config.js','mobile/metro.config.js','mobile/.gitignore','mobile/CLAUDE.md'];
files.push('.gitattributes');
const ignored=new Set(['.git','.local','node_modules','data','.cache','.expo','.cxx','.gradle','build','dist','__pycache__']);
const allowedFile=f=>!/(?:\.local\.|\.(?:log|jks|keystore|pem|crt|key|p12|apk|zip|db|sqlite)(?:$|-)|\.tsbuildinfo$)/i.test(f);
export function exportSource(destination){
 if(fs.existsSync(destination))throw Error('Export destination already exists; choose a fresh directory');
 fs.mkdirSync(destination,{recursive:true});
 for(const name of [...files,...folders]){
  const src=path.join(root,name);if(!fs.existsSync(src))continue;
  fs.cpSync(src,path.join(destination,name),{recursive:true,filter:entry=>{
   const relative=path.relative(root,entry).replaceAll('\\','/');
   return !relative.startsWith('mobile/src/generated')&&!relative.split('/').some(part=>ignored.has(part))&&allowedFile(relative)&&!fs.lstatSync(entry).isSymbolicLink();
  }});
 }
 fs.writeFileSync(path.join(destination,'.public-source.json'),JSON.stringify({format:1,source:'remotecc-clean-export',version},null,2)+'\n');
 const result=spawnSync(process.execPath,[path.join(root,'scripts/audit-public-source.mjs'),`--root=${destination}`],{stdio:'inherit'});
 if(result.status!==0)throw Error('Export failed privacy audit');
 return destination;
}
if(path.resolve(process.argv[1]||'')===import.meta.filename){const target=process.argv.find(x=>x.startsWith('--out='))?.slice(6)||path.join(releaseRoot,'source');console.log(exportSource(path.resolve(target)));}
