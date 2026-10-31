import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const folder=path.resolve(import.meta.dirname,'../.local/release');fs.mkdirSync(folder,{recursive:true});
const store=path.join(folder,'release.jks'),password=path.join(folder,'keystore-password.txt');
if(fs.existsSync(store)){if(!fs.existsSync(password))throw Error('Existing signing key has no local password file; configure signing environment variables.');console.log('Using the existing local release key.');process.exit(0);}
if(!fs.existsSync(password))fs.writeFileSync(password,randomBytes(32).toString('base64url')+'\n',{mode:0o600});
const result=spawnSync(process.argv[2]||'keytool',['-genkeypair','-keystore',store,'-storetype','PKCS12','-storepass:file',password,'-keypass:file',password,'-alias','remotecc','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=RemoteCC Release'],{stdio:'pipe',windowsHide:true});
if(result.error||result.status!==0)throw Error('Release key generation failed. Check the JDK keytool installation.');
console.log('Created a private release signing key under .local/release. Keep it backed up; never publish that directory.');
