import fs from 'node:fs';
import path from 'node:path';
const [source,target]=process.argv.slice(2);
if(!source||!target)throw Error('source and staging directory required');
const root=path.resolve(source);
const fresh=process.argv.includes('--fresh-native');
fs.cpSync(root,target,{recursive:true,dereference:true,filter:entry=>{
 const r=path.relative(root,entry).replaceAll('\\','/');
 if(fresh&&(r==='android'||r.startsWith('android/')))return false;
 return !/^android\/(?:build|\.gradle|\.cxx)(?:\/|$)/.test(r)&&!/^android\/app\/(?:build|\.cxx)(?:\/|$)/.test(r)&&!/(?:^|\/)node_modules\/.+\/android\/(?:build|\.cxx|\.gradle)(?:\/|$)/.test(r)&&!/^node_modules\/\.cache(?:\/|$)/.test(r);
}});
console.log('Android source staged');
