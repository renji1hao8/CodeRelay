import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const marker='.public-source.json';
if(JSON.parse(fs.readFileSync(marker,'utf8')).source!=='remotecc-clean-export')throw Error('Use a clean source export');
const roots=execFileSync('git',['rev-list','--max-parents=0','--all'],{encoding:'utf8'}).trim().split(/\s+/);
for(const commit of roots){const value=JSON.parse(execFileSync('git',['show',`${commit}:${marker}`],{encoding:'utf8'}));if(value.source!=='remotecc-clean-export')throw Error('Historical private repository cannot be released');}
console.log('OK release repository starts with a clean export');
