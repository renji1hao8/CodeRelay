import fs from 'node:fs';
import path from 'node:path';
const development=new Set(['test','tests','example','examples','bench','benchmarks','.github','.claude','.codex','.agents','.vscode']);
export function pruneRuntime(directory){
 const base=path.resolve(directory);
 if(path.basename(base)!=='node_modules')throw Error('Only a packaged node_modules directory may be pruned');
 function walk(folder){for(const item of fs.readdirSync(folder,{withFileTypes:true})){
  const target=path.resolve(folder,item.name);if(!target.startsWith(base+path.sep))throw Error('Path escaped dependency tree');
  if(item.isSymbolicLink())throw Error('Runtime packages must be materialized, not linked');
  if(item.isDirectory()){if(development.has(item.name))fs.rmSync(target,{recursive:true,force:true});else walk(target);}
 }}
 walk(base);
}
if(path.resolve(process.argv[1]||'')===import.meta.filename)pruneRuntime(process.argv[2]);
