$ErrorActionPreference='Stop'
. "$PSScriptRoot\config.ps1"
try{$ready=Invoke-RestMethod "http://127.0.0.1:$BackendPort/api/health" -TimeoutSec 3}catch{$ready=$null}
if(-not $ready){& "$PSScriptRoot\bootstrap.ps1"}
# External proxy/tunnel processes have their own lifecycle; no task names are assumed.
