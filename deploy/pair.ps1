$ErrorActionPreference='Stop'
. "$PSScriptRoot\config.ps1"
& $NodeExe (Join-Path $RemoteCcRoot 'server\scripts\show-pair-info.mjs')
exit $LASTEXITCODE
