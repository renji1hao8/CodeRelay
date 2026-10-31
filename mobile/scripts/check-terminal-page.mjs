import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const sent=[],listeners={},writes=[],queries=[];let term;
class Terminal {
 constructor(){term=this;this.cols=80;this.rows=24;this.parser={registerCsiHandler:(id,fn)=>queries.push([id,fn]),registerOscHandler:()=>{}};}
 loadAddon(){}open(){}onData(fn){this.data=fn;}onResize(){}resize(cols,rows){this.cols=cols;this.rows=rows;}reset(){writes.push('RESET');}write(text,done){writes.push(text);done?.();}focus(){}getSelection(){return 'selected';}paste(text){this.data(text);}
}
const context=vm.createContext({Terminal,FitAddon:{FitAddon:class{fit(){}}},requestAnimationFrame:fn=>fn(),ResizeObserver:class{observe(){}},document:{getElementById:()=>({}),addEventListener:(type,fn)=>{listeners.document=fn;}},window:{REMOTE_CC_TERMINAL_THEME:{},ReactNativeWebView:{postMessage:text=>sent.push(JSON.parse(text))},addEventListener:(type,fn)=>{listeners.window=fn;}}});
vm.runInContext(fs.readFileSync(new URL('../src/shell/terminal-page.js',import.meta.url),'utf8'),context);
assert.equal(sent[0].t,'ready');
const emit=frame=>{const event={data:JSON.stringify(frame)};listeners.document(event);listeners.window(event);};
emit({t:'terminal_data',id:'A',seq:6,data:'new'});emit({t:'terminal_data',id:'A',seq:3,data:'stale'});
emit({t:'terminal_state',id:'A',seq:5,cols:80,rows:24,screen:'screen'});
assert.equal(writes.filter(s=>s==='RESET').length,1);assert.ok(writes.includes('new'));assert.ok(!writes.includes('stale'));
emit({t:'terminal_data',id:'A',seq:6,data:'duplicate'});assert.ok(!writes.includes('duplicate'));
console.log('OK snapshot/output sequence alignment and Android bubbling do not duplicate the screen');
emit({t:'paste',text:'hello'});assert.equal(sent.filter(f=>f.t==='input'&&f.data==='hello').length,1);
emit({t:'control',value:true});term.data('c');assert.equal(sent.at(-1).data,'\x03');assert.ok(sent.some(f=>f.t==='controlUsed'));
console.log('OK paste is delivered once and Ctrl+C maps to a control character');
assert.ok(queries.filter(([id])=>id.final==='n'||id.final==='c').every(([,fn])=>fn()===true));
assert.ok(!sent.some(f=>f.t==='input'&&/\x1b\[[\d;]*R/.test(f.data)));
console.log('OK phone renderer does not replay device-query replies as input');
