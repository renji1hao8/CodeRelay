param([int]$Port, [string]$Executable, [ValidateSet('claude','codex')][string]$Provider)
$ErrorActionPreference='Stop'
if ($Port -lt 1024 -or $Port -gt 65535) { exit 1 }
if ($Provider -eq 'claude' -and [IO.Path]::GetFileName($Executable) -ne 'Claude.exe') { exit 1 }
if ($Provider -eq 'codex' -and [IO.Path]::GetFileName($Executable) -ne 'ChatGPT.exe') { exit 1 }
$owners=@()
foreach($line in (& netstat.exe -ano -p tcp)) {
  $columns=$line.Trim() -split '\s+'
  if($columns.Count -lt 5 -or $columns[0] -ne 'TCP' -or $columns[1] -ne "127.0.0.1:$Port") { continue }
  $processId=0
  if([int]::TryParse($columns[4],[ref]$processId) -and $processId -gt 0) { $owners += $processId }
}
foreach($processId in ($owners | Select-Object -Unique)) {
  $owner=Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if($owner -and $owner.ExecutablePath -eq $Executable) { exit 0 }
}
exit 1
