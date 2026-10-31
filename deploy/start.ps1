param([switch]$NoPair)
$ErrorActionPreference='Stop'
. "$PSScriptRoot\config.ps1"
if(-not(Test-Path -LiteralPath (Join-Path $ServerDir 'node_modules\fastify'))){throw 'Run setup.cmd first.'}
[IO.Directory]::CreateDirectory($LogDir)|Out-Null
$health="http://127.0.0.1:$BackendPort/api/health"
try{$ready=Invoke-RestMethod $health -TimeoutSec 2}catch{$ready=$null}
if(-not $ready){
 $process=Start-Process -FilePath $NodeExe -ArgumentList @('src/index.ts') -WorkingDirectory $ServerDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogDir 'server.out.log') -RedirectStandardError (Join-Path $LogDir 'server.err.log') -PassThru
 [IO.File]::WriteAllText((Join-Path $ServerDir 'data\backend.pid'),[string]$process.Id)
 for($i=0;$i -lt 30;$i++){Start-Sleep -Milliseconds 500;try{$ready=Invoke-RestMethod $health -TimeoutSec 1;break}catch{};if($process.HasExited){throw "Backend exited. Read $LogDir\server.err.log"}}
 if(-not $ready){throw "Backend did not start. Read $LogDir\server.err.log"}
}
Write-Host ("RemoteCC "+$ready.version+" is running. Closing this window does not stop the backend.")
if(-not $NoPair){& $NodeExe (Join-Path $ServerDir 'scripts\show-pair-info.mjs')}
