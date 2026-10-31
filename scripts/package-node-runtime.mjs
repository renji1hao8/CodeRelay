import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const destination=process.argv[2],version=process.versions.node;
if(!destination)throw Error('Output directory required');
async function download(url){let failure;for(let attempt=0;attempt<3;attempt++){try{const result=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!result.ok)throw Error('Download HTTP '+result.status);return await result.text();}catch(error){failure=error;}}throw failure;}
const sums=await download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`);
const expected=sums.split('\n').find(l=>l.trim().endsWith('win-x64/node.exe'))?.trim().split(/\s+/)[0];
const binary=fs.readFileSync(process.execPath),sha256=crypto.createHash('sha256').update(binary).digest('hex');
if(!expected||sha256!==expected)throw Error('Node binary differs from official release');
const license=await download(`https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`);
fs.mkdirSync(destination,{recursive:true});fs.writeFileSync(path.join(destination,'node.exe'),binary);fs.writeFileSync(path.join(destination,'LICENSE.txt'),license);
fs.writeFileSync(path.join(destination,'ORIGIN.json'),JSON.stringify({version,platform:'win-x64',sha256,source:`https://nodejs.org/dist/v${version}/`},null,2)+'\n');
console.log('OK official Node runtime checksum and complete license');
