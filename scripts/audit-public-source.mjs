import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const history=process.argv.includes('--history');
const targetArg=process.argv.find(x=>x.startsWith('--root='));
const target=targetArg?path.resolve(targetArg.slice(7)):root;
const markerFile=path.join(root,'.local/redaction-markers.json');
const markers=fs.existsSync(markerFile)?JSON.parse(fs.readFileSync(markerFile,'utf8')):[];
const rules=[
 ['personal-home',/[A-Z]:[\\/]+Users[\\/]+(?!Public(?:[\\/]|\b)|Default(?:[\\/]|\b)|<|example(?:[\\/]|\b)|username(?:[\\/]|\b))[A-Za-z0-9_.-]+[\\/]/i],
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['provider-key',/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,})\b/],
 ['jwt',/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/],
 ['literal-password',/(?:password|passwd|api_key|apiKey|authToken|secret)\s*[:=]\s*["'][A-Za-z0-9+/_!@#$%=-]{12,}["']/i],
];
const ignored=new Set(['.git','.local','node_modules','data','dist','.expo','.apk-out','.codex-remote-attachments','artifacts','build','.cache','.cxx','.gradle']);
const textFile=file=>/\.(?:[cm]?[jt]sx?|json|md|ps1|sh|py|vbs|cmd|bat|kt|kts|java|c|cc|cpp|h|hpp|html|css|svg|ya?ml|toml|xml|crt|ini|config|properties|txt)$/.test(file)||/\/(?:LICENSE|\.gitignore|\.npmrc|\.env(?:\.[^/]*)?)$/.test('/'+file);
const findings=[];
function check(content,file,object){
 const lines=content.split(/\r?\n/);
 for(let i=0;i<lines.length;i++){
  for(const [rule,pattern]of rules)if(pattern.test(lines[i]))findings.push({file,line:i+1,rule,...(object?{object}:{})});
  const normal = value => value.replaceAll('\\\\','\\').replaceAll('\\','/').toLowerCase();
  if(markers.some(value=>value&&normal(lines[i]).includes(normal(value))))findings.push({file,line:i+1,rule:'private-marker',...(object?{object}:{})});
 }
}
if(history){
 const objects=execFileSync('git',['rev-list','--objects','--all'],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024}).trim().split('\n');
 for(const row of objects){const space=row.indexOf(' ');if(space<0)continue;const object=row.slice(0,space),file=row.slice(space+1);if(!textFile(file))continue;
  const type=execFileSync('git',['cat-file','-t',object],{cwd:root,encoding:'utf8'}).trim();if(type!=='blob')continue;
  check(execFileSync('git',['cat-file','blob',object],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}),file,object);
 }
}else{
 function walk(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){if(ignored.has(entry.name)||entry.isSymbolicLink())continue;const file=path.join(folder,entry.name),relative=path.relative(target,file).replaceAll('\\','/');if(entry.isDirectory()){if(relative==='mobile/android')continue;walk(file);}else if(textFile(relative)&&!entry.name.includes('.local.'))check(fs.readFileSync(file,'utf8'),relative);}}
 walk(target);
}
const report={scope:history?'history':'source',files:new Set(findings.map(f=>f.file)).size,findings};
const outArg=process.argv.find(x=>x.startsWith('--out='));if(outArg){const out=path.resolve(outArg.slice(6));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');}
const counts={};for(const finding of findings)counts[finding.rule]=(counts[finding.rule]||0)+1;
console.log(JSON.stringify({scope:report.scope,files:report.files,counts,total:findings.length}));
if(!process.argv.includes('--summary-only'))for(const finding of findings.slice(0,100))console.log(`${finding.rule} ${finding.file}:${finding.line}`);
process.exitCode=findings.length?1:0;
