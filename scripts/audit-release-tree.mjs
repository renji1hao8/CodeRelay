import fs from 'node:fs';
import path from 'node:path';
import {releaseRoot} from './export-public-source.mjs';
const target=path.resolve(process.argv[2]||path.join(releaseRoot,'source'));
let files=0;
function walk(folder){for(const e of fs.readdirSync(folder,{withFileTypes:true})){const absolute=path.join(folder,e.name),relative=path.relative(target,absolute).replaceAll('\\','/');
 if(e.isSymbolicLink())throw Error('Release contains a symlink: '+relative);
 if(['.git','.local','.pnpm','.cache','.expo','.gradle','.cxx'].includes(e.name)||/\.local\.|\.(?:jks|keystore|p12|key|crt|pem|log|db|sqlite)$/i.test(e.name))throw Error('Forbidden release file: '+relative);
 if(relative==='server/data'||relative==='mobile/android'||relative.startsWith('mobile/modules/remote-cc-zerotier'))throw Error('Private or generated tree included: '+relative);
 if(e.isDirectory())walk(absolute);else files++;
}}
walk(target);console.log(`OK ${files} release files: no private tree, local configuration, keys, runtime database or symlinks`);
