import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
// These checks use fixtures only. Real desktop and model requests are separate manual checks.
const checks={server:['claude-open','claude-sessions','codex-items','codex-live','codex-local','desktop-control','desktop-sync','vendored-bridge','history-worker','public-defaults','shell-lines','user-content','public-http'],mobile:['app-update','billing','cjk-markdown','codex-chat','codex-quota','codex-tree','deep-link','desktop-state','health','message-merge','nested-shell','slash-command','terminal-page']};
for(const [folder,names]of Object.entries(checks))for(const name of names){
 const file=`${folder}/scripts/check-${name}.mjs`;
 console.log(`\n${file}`);
 const result=spawnSync(process.execPath,[file],{cwd:root,stdio:'inherit',windowsHide:true,timeout:60000});
 if(result.error)console.error(result.error.message);
 if(result.status!==0)process.exit(result.status||1);
}
console.log('\nAll fixture and isolated HTTP checks passed.');
