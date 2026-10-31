param([switch]$SkipVersionBump,[switch]$KeepStaging,[switch]$PublicRelease,[string]$JavaHome=$env:JAVA_HOME,[string]$AndroidSdk=$env:ANDROID_HOME,[string]$StageBase=$env:SystemDrive+'\')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
if(-not $JavaHome){$studio=Join-Path $env:ProgramFiles 'Android\Android Studio\jbr';if(Test-Path -LiteralPath $studio){$JavaHome=$studio}}
if(-not $JavaHome){throw 'Set JAVA_HOME to JDK 21, or pass -JavaHome <JDK directory>.'}
if(-not $AndroidSdk){$AndroidSdk=Join-Path $env:LOCALAPPDATA 'Android\Sdk'}
if(-not(Test-Path -LiteralPath $AndroidSdk)){throw 'Install the Android SDK, then set ANDROID_HOME or pass -AndroidSdk.'}
$env:JAVA_HOME=$JavaHome;$env:ANDROID_HOME=$AndroidSdk;$env:ANDROID_SDK_ROOT=$AndroidSdk
$env:NODE_ENV='production'
if($PublicRelease){
 if($env:CI -eq 'true' -and -not $env:REMOTE_CC_KEYSTORE){throw 'CI releases require a stable signing key from repository Secrets.'}
 $env:REMOTE_CC_PUBLIC_BUILD='1'
 Remove-Item Env:REMOTE_CC_ANDROID_CA_CERT -ErrorAction SilentlyContinue
 if(-not $env:REMOTE_CC_KEYSTORE){& node (Join-Path $PSScriptRoot 'create-signing-key.mjs') (Join-Path $JavaHome 'bin\keytool.exe');if($LASTEXITCODE -ne 0){exit $LASTEXITCODE};$keyRoot=Join-Path $projectRoot '.local\release';$env:REMOTE_CC_KEYSTORE=Join-Path $keyRoot 'release.jks';$env:REMOTE_CC_KEYSTORE_PASSWORD=(Get-Content -LiteralPath (Join-Path $keyRoot 'keystore-password.txt') -Raw).Trim();$env:REMOTE_CC_KEY_ALIAS='remotecc';$env:REMOTE_CC_KEY_PASSWORD=$env:REMOTE_CC_KEYSTORE_PASSWORD}
}
if(-not $SkipVersionBump){& node (Join-Path $PSScriptRoot 'bump-app-version.mjs');if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}}
foreach($file in @('sync-version.mjs','build-terminal.mjs','build-notices.mjs')){& node (Join-Path $projectRoot ('mobile\scripts\'+$file));if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}}
if(-not $PublicRelease){
 if(-not(Test-Path -LiteralPath (Join-Path $projectRoot 'mobile\android\gradlew.bat'))){Push-Location (Join-Path $projectRoot 'mobile');try{& npx.cmd --no-install expo prebuild --platform android --no-install;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}}finally{Pop-Location}}
 & node (Join-Path $PSScriptRoot 'patch-android-project.mjs');if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
}
$stageParent=[IO.Path]::GetFullPath($StageBase).TrimEnd('\')+'\'
$stageRoot=Join-Path $stageParent ('rcc-build-'+[guid]::NewGuid().ToString('N').Substring(0,8))
$mobileStage=Join-Path $stageRoot 'm'
$stageArgs=@((Join-Path $PSScriptRoot 'stage-android-build.mjs'),(Join-Path $projectRoot 'mobile'),$mobileStage)
if($PublicRelease){$stageArgs+='--fresh-native'}
& node @stageArgs
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
Write-Output "ASCII Android build: $mobileStage"
if($PublicRelease){
 Push-Location $mobileStage
 try{& npx.cmd --no-install expo prebuild --platform android --no-install;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}}finally{Pop-Location}
 & node (Join-Path $PSScriptRoot 'patch-android-project.mjs') ("--android-root="+(Join-Path $mobileStage 'android'));if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
}
Push-Location (Join-Path $mobileStage 'android')
try{& '.\gradlew.bat' ':app:assembleRelease' '-Pandroid.overridePathCheck=true' '-PreactNativeArchitectures=arm64-v8a,x86_64' '--console=plain';$buildExit=$LASTEXITCODE}finally{Pop-Location}
if($buildExit -ne 0){Write-Output "Build failed; diagnostics kept at $stageRoot";exit $buildExit}
$out=Join-Path $projectRoot 'mobile\android\app\build\outputs\apk\release'
[IO.Directory]::CreateDirectory($out)|Out-Null
foreach($file in @('app-release.apk','output-metadata.json')){Copy-Item -LiteralPath (Join-Path $mobileStage ('android\app\build\outputs\apk\release\'+$file)) -Destination (Join-Path $out $file) -Force}
& (Join-Path $PSScriptRoot 'audit-android.ps1') -Apk (Join-Path $out 'app-release.apk')
$resolved=[IO.Path]::GetFullPath($stageRoot)
if([IO.Path]::GetDirectoryName($resolved).TrimEnd('\') -ne $stageParent.TrimEnd('\') -or [IO.Path]::GetFileName($resolved) -notmatch '^rcc-build-[a-f0-9]{8}$'){throw 'Unexpected staging path'}
if(-not $KeepStaging){try{Remove-Item -LiteralPath $resolved -Recurse -Force}catch{Write-Warning "APK copied; a build cache file is locked at $resolved"}}
Write-Output "Build succeeded: $out\app-release.apk"
