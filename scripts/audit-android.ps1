param([Parameter(Mandatory=$true)][string]$Apk,[string]$MarkerFile='')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot=Split-Path -Parent $PSScriptRoot
if(-not $MarkerFile){$MarkerFile=Join-Path $projectRoot '.local\redaction-markers.json'}
$markers=@([Environment]::GetFolderPath('UserProfile'),$projectRoot)
if(Test-Path -LiteralPath $MarkerFile){$markers+=@(Get-Content -LiteralPath $MarkerFile -Raw | ConvertFrom-Json)}
$needles=@($markers | Where-Object {$_ -and $_.Length -gt 5} | ForEach-Object {$_.Replace('\','/').ToLowerInvariant()} | Select-Object -Unique)
$archive=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Apk))
$findings=@()
try{
 foreach($entry in $archive.Entries){
  if($entry.FullName -match '(?i)remotecc_cert|\.(pem|jks|keystore|key)$'){$findings+=($entry.FullName+' [certificate/signing file]');continue}
  $stream=$entry.Open();$memory=New-Object IO.MemoryStream
  try{$stream.CopyTo($memory);$bytes=$memory.ToArray()}finally{$stream.Dispose();$memory.Dispose()}
  foreach($encoding in @([Text.Encoding]::UTF8,[Text.Encoding]::Unicode)){
   $text=$encoding.GetString($bytes).Replace('\','/').ToLowerInvariant()
   if(@($needles | Where-Object {$text.Contains($_)}).Count){$findings+=($entry.FullName+' [private build marker]');break}
  }
 }
 if(-not ($archive.Entries | Where-Object FullName -eq 'assets/third-party-notices.txt')){throw 'Android third-party license asset missing'}
}finally{$archive.Dispose()}
if($findings.Count){$findings | Select-Object -Unique | Write-Output;throw 'APK privacy audit failed; marker values are never printed'}
Write-Output 'OK APK entries: no known personal build markers, custom CA or signing key; license notices included'
