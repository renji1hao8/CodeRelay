import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
const root=fs.mkdtempSync(path.join(tmpdir(),'remotecc-rollout-test-'));
process.env.REMOTE_CC_CODEX_HOME=root;process.env.REMOTE_CC_DATA_DIR=path.join(root,'data');
const {readRollout,readLocalCodex,rolloutMessage}=await import('../src/history/codex-local.ts');
const file=path.join(root,'rollout.jsonl');
const record=(text,role='assistant')=>JSON.stringify({timestamp:'2026-10-31T00:00:00Z',type:'response_item',payload:{type:'message',role,content:[{type:role==='user'?'input_text':'output_text',text}]}})+'\n';
try{
 fs.writeFileSync(file,Array.from({length:350},(_,i)=>record('消息 '+i,i%2?'assistant':'user')).join(''));
 const database=new DatabaseSync(path.join(root,'state_5.sqlite'));database.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT)');
 database.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('T','超长会话',root,1793400000,file);database.close();
 let page=readLocalCodex('T'),ids=new Set();let total=0;
 while(page){for(const message of page.messages){assert.ok(!ids.has(message.uuid));ids.add(message.uuid);total++;}if(!page.olderCursor)break;page=readLocalCodex('T',page.olderCursor);}
 assert.equal(total,350);console.log('OK large single turn paginates by records with stable IDs and no overlap');
 const first=readRollout(file,'T');const lastId=first.messages.at(-1).uuid;
 const partial=record('中文跨片段追加');fs.appendFileSync(file,partial.slice(0,-3));assert.equal(readRollout(file,'T').messages.at(-1).uuid,lastId);
 fs.appendFileSync(file,partial.slice(-3));assert.equal(readRollout(file,'T').messages.at(-1).blocks[0].text,'中文跨片段追加');
 assert.equal(readRollout(file,'T',first.olderCursor).messages.at(-1).uuid,readRollout(file,'T',first.olderCursor).messages.at(-1).uuid);console.log('OK partial appended records are retained until complete');
 assert.equal(rolloutMessage({type:'response_item',payload:{type:'reasoning',summary:[{text:'private'}]}},'R'),null);
 const use=rolloutMessage({type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'C',arguments:JSON.stringify({cmd:'npm test',description:'检查修改'})}},'U');
 assert.equal(use.blocks[0].name,'command');assert.equal(use.blocks[0].input.command,'npm test');assert.equal(use.blocks[0].input.description,'检查修改');
 const result=rolloutMessage({type:'response_item',payload:{type:'function_call_output',call_id:'C',output:'通过'}},'O');assert.equal(result.blocks[0].toolUseId,'C');assert.equal(result.blocks[0].text,'通过');console.log('OK tool linkage and descriptions retained, reasoning never rendered');
 const envelope='<codex_delegation>\n<source_thread_id>source</source_thread_id>\n<input>手机消息\n第二行</input>\n</codex_delegation>';
 const received=rolloutMessage({type:'response_item',payload:{type:'function_call_output',name:'send_message_to_thread',output:envelope}},'incoming');
 assert.equal(received.role,'user');assert.equal(received.blocks[0].text,'手机消息\n第二行');
 const quoted=rolloutMessage({type:'response_item',payload:{type:'function_call_output',call_id:'real-tool',output:envelope}},'quoted');assert.equal(quoted.blocks[0].type,'tool_result');
 assert.equal(rolloutMessage({type:'response_item',payload:{type:'function_call_output',name:'send_message_to_thread',output:'示例 '+envelope}},'example').role,'assistant');
 const metadata={type:'response_item',payload:{type:'message',role:'user',internal_chat_message_metadata_passthrough:{content_item_kinds:['additional_content.codex_apps_open_page']},content:[{type:'input_text',text:'<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'}]}};
 assert.equal(rolloutMessage(metadata,'metadata'),null);
 delete metadata.payload.internal_chat_message_metadata_passthrough;assert.ok(rolloutMessage(metadata,'user-example'));
 console.log('OK incoming delegation restores a user turn; metadata is hidden without removing tool examples or literal user XML');
 fs.writeFileSync(file,record('重写'));assert.equal(readRollout(file,'T').messages.length,1);assert.throws(()=>readRollout(file,'T','codex-local-v1:1'));
 console.log('OK truncation rebuild and invalid cursor rejection');
 assert.equal(readLocalCodex('missing'),null);
 const outside=path.join(tmpdir(),path.basename(root)+'-outside.jsonl');fs.writeFileSync(outside,record('outside'));
 try{const db=new DatabaseSync(path.join(root,'state_5.sqlite'));db.prepare('UPDATE threads SET rollout_path=?').run(outside);db.close();assert.throws(()=>readLocalCodex('T'),/路径无效/);}finally{fs.unlinkSync(outside);}
 console.log('OK only the verified Codex home may supply rollout data');
}finally{
 const target=path.resolve(root),base=path.resolve(tmpdir());if(path.dirname(target)!==base||!path.basename(target).startsWith('remotecc-rollout-test-'))throw Error('unsafe fixture root');fs.rmSync(target,{recursive:true,force:true});
}
