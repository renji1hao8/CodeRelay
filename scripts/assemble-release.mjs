import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {exportSource,root,version,releaseRoot} from './export-public-source.mjs';
const windows=path.join(releaseRoot,'windows'),source=path.join(releaseRoot,'source');
if(!fs.existsSync(path.join(windows,'runtime/node.exe'))||!fs.existsSync(path.join(windows,'server/node_modules/fastify')))throw Error('Run package-windows.mjs first');
const apk=path.join(root,'mobile/android/app/build/outputs/apk/release/app-release.apk');
const metadata=JSON.parse(fs.readFileSync(path.join(path.dirname(apk),'output-metadata.json')));
const app=JSON.parse(fs.readFileSync(path.join(root,'mobile/app.json'))).expo;
if(metadata.elements[0].versionName!==version||metadata.elements[0].versionCode!==app.android.versionCode)throw Error('APK version mismatch');
for(const args of [[process.execPath,[path.join(root,'scripts/audit-release-tree.mjs'),windows]],['powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/audit-android.ps1'),'-Apk',apk]]]){const result=spawnSync(args[0],args[1],{stdio:'inherit',windowsHide:true});if(result.status!==0)throw Error('Release privacy guard failed');}
for(const name of [`RemoteCC-${version}-Windows.zip`,`RemoteCC-${version}-Source.zip`,`RemoteCC-${version}-Android.apk`])if(fs.existsSync(path.join(releaseRoot,name)))throw Error('Release asset already exists: '+name);
exportSource(source);
if(spawnSync(process.execPath,[path.join(root,'scripts/audit-release-tree.mjs'),source],{stdio:'inherit'}).status!==0)throw Error('Source tree audit failed');
fs.copyFileSync(apk,path.join(releaseRoot,`RemoteCC-${version}-Android.apk`));
fs.copyFileSync(path.join(root,'mobile/assets/third-party-notices.txt'),path.join(releaseRoot,`RemoteCC-${version}-Android-Notices.txt`));
for(const [folder,label]of [[windows,'Windows'],[source,'Source']]){
 const zip=path.join(releaseRoot,`RemoteCC-${version}-${label}.zip`);
 const script=path.join(root,'scripts/zip-release.ps1');
 const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Source',folder,'-Destination',zip],{stdio:'inherit',windowsHide:true});if(result.status!==0)throw Error('ZIP failed');
}
const names=fs.readdirSync(releaseRoot).filter(f=>/\.(apk|zip)$/.test(f)||f.endsWith('-Notices.txt')).sort();
fs.writeFileSync(path.join(releaseRoot,'SHA256SUMS.txt'),names.map(name=>`${crypto.createHash('sha256').update(fs.readFileSync(path.join(releaseRoot,name))).digest('hex')}  ${name}`).join('\n')+'\n');
console.log('Release assets ready: '+releaseRoot);
