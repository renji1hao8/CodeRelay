import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const temporary=await mkdtemp(path.join(tmpdir(),'remotecc-terminal-test-'));
process.env.REMOTE_CC_DATA_DIR=path.join(temporary,'data');
const {InteractiveTerminal}=await import(process.env.REMOTE_CC_TEST_ROOT?pathToFileURL(path.join(process.env.REMOTE_CC_TEST_ROOT,'server/src/shell/terminal.ts')).href:'../src/shell/terminal.ts');
let terminal, childPid;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function text(){const b=terminal.screen.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\n');}
async function until(value,timeout=12000){const deadline=Date.now()+timeout;while(Date.now()<deadline){await terminal.snapshot();if(text().includes(value))return;await wait(80);}throw Error('Terminal did not produce expected marker: '+value);}
try{
  await mkdir(path.join(temporary,'子 目录'));
  terminal=new InteractiveTerminal('fixture',80,24,{args:['-NoLogo','-NoProfile','-NoExit','-Command','Import-Module PSReadLine; Set-PSReadLineOption -HistorySaveStyle SaveNothing'],cwd:temporary,audit:false});
  const pid=terminal.process.pid;
  terminal.input("Write-Output ('PROBE_' + 'READY')\r");await until('PROBE_READY');
  terminal.input("$remoteccProbe=41; Set-Location -LiteralPath '子 目录'; Write-Output ('FIRST_' + 'DONE')\r");await until('FIRST_DONE');
  terminal.input("Write-Output ('STATE_' + ($remoteccProbe+1) + '_' + $pwd.Path.EndsWith('子 目录'))\r");await until('STATE_42_True');
  console.log('OK persistent variables and Unicode working directory');
  terminal.input("$reply=Read-Host 'Input'; Write-Output ('ANSWER_' + $reply)\r");await wait(400);terminal.input('hello\r');await until('ANSWER_hello');
  console.log('OK Read-Host accepts interactive stdin');
  terminal.input("$remoteccCompletionValue=99;Write-Output ('PREP_'+'DONE')\r");await until('PREP_DONE');
  terminal.input("Write-Output ('TAB_' + $remoteccCompletionV\t)\r");await until('TAB_99');
  terminal.input("$remoteccHistoryProbe++;Write-Output ('HISTORY_'+$remoteccHistoryProbe)\r");await until('HISTORY_1');
  terminal.input('\x1b[A\r');await until('HISTORY_2');
  console.log('OK native PSReadLine Tab completion and Up-arrow history');
  terminal.input("Start-Sleep -Seconds 60; Write-Output ('UNEXPECTED_' + 'TAIL')\r");await wait(500);terminal.input('\x03');await wait(300);
  terminal.input("Write-Output ('AFTER_' + 'CANCEL')\r");await until('AFTER_CANCEL');assert.equal(terminal.process.pid,pid);assert.ok(!text().includes('UNEXPECTED_TAIL'));
  console.log('OK Ctrl+C interrupts the command while preserving the same pwsh process');
  terminal.resize(70,20);terminal.input("Write-Output ('WIDTH_' + [Console]::WindowWidth)\r");await until('WIDTH_70');
  console.log('OK ConPTY resize updates the real console width');
  const snapshot=await terminal.snapshot();assert.equal(snapshot.cols,70);assert.equal(snapshot.rows,20);assert.ok(snapshot.screen.includes('STATE_42_True'));
  console.log('OK reconnect snapshot preserves rendered screen and cursor state');
  const ended=new InteractiveTerminal('fixture-exit',80,24,{args:['-NoLogo','-NoProfile','-Command','exit 7'],cwd:temporary,audit:false});
  try{const deadline=Date.now()+8000;while(ended.running&&Date.now()<deadline)await wait(50);assert.equal(ended.running,false);assert.equal((await ended.snapshot()).exitCode,7);console.log('OK natural pwsh exit reports its code and releases native handles');}finally{ended.dispose();}
  const childScript=path.join(temporary,'child.mjs');await writeFile(childScript,"console.log('CHILD_'+process.pid);setInterval(()=>{},1000);");
  terminal.input("& '"+process.execPath.replaceAll("'","''")+"' '"+childScript.replaceAll("'","''")+"'\r");
  const deadline=Date.now()+8000;while(Date.now()<deadline){await terminal.snapshot();const match=/^CHILD_(\d+)\s*$/m.exec(text());if(match){childPid=Number(match[1]);break;}await wait(80);}assert.ok(childPid);
}finally{
 terminal?.dispose();await wait(250);
 if(childPid){const deadline=Date.now()+4000;let alive=true;while(Date.now()<deadline){try{process.kill(childPid,0);}catch{alive=false;break;}await wait(80);}assert.equal(alive,false,'closing the terminal must stop its attached child');console.log('OK closing a terminal terminates its own attached child process');}
 const {db}=await import(process.env.REMOTE_CC_TEST_ROOT?pathToFileURL(path.join(process.env.REMOTE_CC_TEST_ROOT,'server/src/db.ts')).href:'../src/db.ts');db.close();
 const target=path.resolve(temporary),base=path.resolve(tmpdir());if(path.dirname(target)!==base||!path.basename(target).startsWith('remotecc-terminal-test-'))throw Error('unsafe fixture path');
 await rm(target,{recursive:true,force:true});
}
