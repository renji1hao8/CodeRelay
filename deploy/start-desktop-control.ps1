param([ValidateSet('claude','codex','both')][string]$Provider='both', [switch]$CreateShortcuts)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$portableNodeDir=Join-Path $root 'runtime'
if(Test-Path -LiteralPath (Join-Path $portableNodeDir 'node.exe')){$env:PATH=$portableNodeDir+';'+$env:PATH}
$settingsPath=Join-Path $root 'server\data\desktop-control.json'
[IO.Directory]::CreateDirectory((Split-Path -Parent $settingsPath))|Out-Null
$settings=@{}
if(Test-Path -LiteralPath $settingsPath) {
  $previous=Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
  foreach($p in $previous.PSObject.Properties){$settings[$p.Name]=$p.Value}
}
foreach($name in @('claude','codex')) {
  if($Provider -ne 'both' -and $Provider -ne $name){continue}
  $packageName=if($name -eq 'claude'){'Claude'}else{'OpenAI.Codex'}
  $package=Get-AppxPackage -Name $packageName | Sort-Object Version -Descending | Select-Object -First 1
  if(-not $package){Write-Warning "未找到 $name 桌面端";continue}
  $exeName=if($name -eq 'claude'){'Claude.exe'}else{'ChatGPT.exe'}
  $exe=Join-Path $package.InstallLocation ('app\'+$exeName)
  $port=if($name -eq 'claude'){9341}else{9342}
  $settings[$name]=@{port=$port;executable=$exe}
  if($CreateShortcuts){
    $shell=New-Object -ComObject WScript.Shell
    $link=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) ("$name 手机控制.lnk")))
    $link.TargetPath='powershell.exe'
    $link.Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$PSCommandPath+'" -Provider '+$name
    $link.WorkingDirectory=$root;$link.IconLocation=$exe;$link.Save()
  }
  $running=Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($exeName)) -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $exe}
  if($running){Write-Output "$name 已在运行。保存控制连接配置；下次完全退出后用手机控制快捷方式打开。";continue}
  Start-Process -FilePath $exe -ArgumentList @("--remote-debugging-port=$port",'--remote-debugging-address=127.0.0.1') -WindowStyle Hidden
  Write-Output "$name 已开启本机手机控制连接"
}
[IO.File]::WriteAllText($settingsPath,($settings | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
