# 注册两个计划任务:登录时 bootstrap,之后每 5 分钟 watchdog
# 以当前用户身份运行,不使用 SYSTEM(后端能执行 shell,权限越小越好)
. "$PSScriptRoot\config.ps1"

# 注册登录触发任务需要管理员权限,否则报 0x80070005
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "需要管理员权限,正在提权重跑(会弹 UAC)..." -ForegroundColor Yellow
    Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    exit $LASTEXITCODE
}

# 经 wscript 转一手,而不是让计划任务直接跑 powershell.exe
#
# 直接跑的话:Windows 会先为 powershell.exe 分配一个控制台,PowerShell 才开始执行、
# 才轮到 -WindowStyle Hidden 生效 —— 等它生效,窗口已经闪过了。看门狗每 5 分钟一次,
# 于是每 5 分钟闪一下黑框(2026-09-19 实测定位)。
#
# wscript.exe 是 GUI 子系统程序,压根不申请控制台,所以没有任何窗口宿主
# (经典 conhost / OpenConsole / 被委派给 Windows Terminal)有东西可显示。
$wscript = "$env:SystemRoot\System32\wscript.exe"
$hidden = Join-Path $PSScriptRoot "run-hidden.vbs"

if (-not (Test-Path $hidden)) {
    Write-Host "找不到 $hidden —— 没有它任务会重新开始闪窗口" -ForegroundColor Red
    exit 1
}

function New-RemoteCcTask {
    param([string]$Name, [string]$ScriptFile, $Trigger, [string]$Description)
    # //B 静默(不弹脚本错误对话框)、//Nologo 不显示横幅
    $action = New-ScheduledTaskAction -Execute $wscript `
        -Argument "//B //Nologo `"$hidden`" `"$ScriptFile`""
    # -Hidden 是任务自身的隐藏标记,和上面的 shim 是两道保险:shim 负责"不产生窗口",
    # 这一条负责"即使产生了也不显示"。
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -Hidden
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger -Settings $settings -Principal $principal `
        -Description $Description -Force | Out-Null
    Write-Host "已注册任务: $Name"
}

# 登录后延迟 30 秒(等网络与用户态程序就绪)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$logonTrigger.Delay = "PT30S"
New-RemoteCcTask -Name "RemoteCC-Bootstrap" -ScriptFile "bootstrap.ps1" `
    -Trigger $logonTrigger -Description "RemoteCC: start the backend after sign-in"

# 每 5 分钟探活一次,永久重复
$watchTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
New-RemoteCcTask -Name "RemoteCC-Watchdog" -ScriptFile "watchdog.ps1" `
    -Trigger $watchTrigger -Description "远程cc:每 5 分钟探活并自愈"

Write-Host "`n当前状态:"
Get-ScheduledTask -TaskName "RemoteCC-*" | Select-Object TaskName, State | Format-Table -AutoSize

Write-Host "已注册任务的启动方式(应全部是 wscript.exe):"
Get-ScheduledTask -TaskName "RemoteCC-*" | ForEach-Object {
    Write-Host ("  {0,-22} {1}" -f $_.TaskName, $_.Actions[0].Execute)
}
