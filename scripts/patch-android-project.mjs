import fs from 'node:fs';
import path from 'node:path';
const override=process.argv.find(x=>x.startsWith('--android-root='));
const root=override?path.resolve(override.slice(15)):path.resolve(import.meta.dirname,'../mobile/android');
const app=JSON.parse(fs.readFileSync(path.resolve(root,'../app.json'),'utf8')).expo;
const patch=(name,change)=>{const file=path.join(root,name),before=fs.readFileSync(file,'utf8'),after=change(before);if(before!==after)fs.writeFileSync(file,after);};
const write=(name,text)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
const notices=path.resolve(root,'../assets/third-party-notices.txt');
if(fs.existsSync(notices))write('app/src/main/assets/third-party-notices.txt',fs.readFileSync(notices,'utf8'));
else if(process.env.REMOTE_CC_PUBLIC_BUILD==='1')throw Error('Generate Android license notices before public build');
patch('settings.gradle',s=>s.replace(/^rootProject\.name = .*$/m,"rootProject.name = 'coderelay'"));
patch('gradle.properties',s=>s.includes('overridePathCheck')?s:s+'\nandroid.overridePathCheck=true\n');
if(process.env.REMOTE_CC_BUILD_MIRRORS==='cn'){
 patch('gradle/wrapper/gradle-wrapper.properties',s=>s.replace(/^distributionUrl=.*\/gradle-([\d.]+)-(bin|all)\.zip$/m,(_line,version,kind)=>`distributionUrl=https\\://mirrors.cloud.tencent.com/gradle/gradle-${version}-${kind}.zip`));
 patch('build.gradle',s=>s.includes('maven.aliyun.com')?s:s.replace(/google\(\)/g,"maven { url 'https://maven.aliyun.com/repository/google' }\n    google()").replace(/mavenCentral\(\)/g,"maven { url 'https://maven.aliyun.com/repository/public' }\n    mavenCentral()"));
}
patch('app/src/main/AndroidManifest.xml',s=>{
 let result=s.replace(/android:usesCleartextTraffic="[^"]*"/g,'android:usesCleartextTraffic="true"');
 if(!result.includes('usesCleartextTraffic'))result=result.replace('<application ','<application android:usesCleartextTraffic="true" ');
 if(!result.includes('networkSecurityConfig'))result=result.replace('<application ','<application android:networkSecurityConfig="@xml/network_security_config" ');
 return result;
});
// Public builds trust Android's system roots. Custom CAs are explicit local builds.
const ca=process.env.REMOTE_CC_ANDROID_CA_CERT;
if(process.env.REMOTE_CC_PUBLIC_BUILD==='1'&&ca)throw Error('Public builds cannot contain a custom CA');
const cert=path.join(root,'app/src/main/res/raw/remotecc_cert.pem');
if(ca)write('app/src/main/res/raw/remotecc_cert.pem',fs.readFileSync(path.resolve(ca),'utf8'));
else if(fs.existsSync(cert))fs.unlinkSync(cert);
write('app/src/main/res/xml/network_security_config.xml',`<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors><certificates src="system" />${ca?'\n      <certificates src="@raw/remotecc_cert" />':''}</trust-anchors>
  </base-config>
</network-security-config>
`);
patch('app/build.gradle',s=>{
 let result=s.replace(/^(\s*)versionCode\s+\d+\s*$/m,`$1versionCode ${app.android.versionCode}`).replace(/^(\s*)versionName\s+"[^"]*"\s*$/m,`$1versionName "${app.version}"`);
 if(!result.includes('// RemoteCC native path privacy')){
  const privacy=String.raw`// RemoteCC native path privacy
def remoteCcPrefixFlags = [
    [gradle.gradleUserHomeDir.absolutePath, '/gradle-cache'],
    [System.getProperty('user.home'), '/build-user'],
    [rootDir.parentFile.absolutePath, '/remotecc']
].collect { pair ->
    def sourcePath = pair[0].replace('\\', '/')
    return "\"-ffile-prefix-map=" + sourcePath + "=" + pair[1] + "\" \"-fdebug-prefix-map=" + sourcePath + "=" + pair[1] + "\""
}.join(' ')
`;
  result=result.replace(/^android\s*\{/m,privacy+'\nandroid {');
  result=result.replace(/defaultConfig\s*\{/,`defaultConfig {
        externalNativeBuild {
            cmake {
                arguments "-DCMAKE_C_FLAGS=" + remoteCcPrefixFlags, "-DCMAKE_CXX_FLAGS=" + remoteCcPrefixFlags
            }
        }`);
 }
 if(!result.includes('CMAKE_OBJECT_PATH_MAX'))result=result.replace('arguments "-DCMAKE_C_FLAGS="','arguments "-DCMAKE_OBJECT_PATH_MAX=240", "-DCMAKE_C_FLAGS="');
 result=result.replace(/CMAKE_OBJECT_PATH_MAX=\d+/g,'CMAKE_OBJECT_PATH_MAX=240');
 if(process.env.REMOTE_CC_KEYSTORE){
  if(!result.includes('// RemoteCC release signing'))result=result.replace(/signingConfigs\s*\{/,`signingConfigs {
        // RemoteCC release signing
        release {
            storeFile file(System.getenv("REMOTE_CC_KEYSTORE"))
            storePassword System.getenv("REMOTE_CC_KEYSTORE_PASSWORD")
            keyAlias System.getenv("REMOTE_CC_KEY_ALIAS")
            keyPassword System.getenv("REMOTE_CC_KEY_PASSWORD")
        }`);
  result=result.replace(/(buildTypes\s*\{[\s\S]*?\brelease\s*\{[\s\S]*?signingConfig\s+)signingConfigs\.debug/,'$1signingConfigs.release');
 }else if(process.env.REMOTE_CC_PUBLIC_BUILD==='1')throw Error('Public release requires a release signing key');
 return result;
});
console.log(`Android configuration ready: ${app.version} (${app.android.versionCode}), TLS=${ca?'custom-local':'system'}`);
