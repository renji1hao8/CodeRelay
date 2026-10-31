$ErrorActionPreference='Stop'
. "$PSScriptRoot\config.ps1"
# Optional workstation programs are only started when explicitly configured.
foreach($exe in @($ClashVergeExe,$CcSwitchExe)){
 if(-not $exe){continue}
 if(-not(Test-Path -LiteralPath $exe -PathType Leaf)){Write-Warning "Configured program missing: $exe";continue}
 $running=Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($exe)) -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $exe}
 if(-not $running){Start-Process -FilePath $exe -WindowStyle Hidden}
}
& "$PSScriptRoot\start.ps1" -NoPair
