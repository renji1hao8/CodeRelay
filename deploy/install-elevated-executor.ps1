# ═══════════════════════════════════════════════════════════════════════════════
#  一次性安装:RemoteCC 提权执行器
#
#  做三件事:
#    1. 建 C:\ProgramData\RemoteCC-Elevated,并把**当前用户的写权限收掉**
#       (只留读+执行,所有者改成 Administrators)—— 这一步是整套东西的安全基石:
#       执行器脚本和白名单在当前用户面前**只读**,被提示注入的 agent 改不动它
#    2. 把 elevated-executor.ps1 拷进去
#    3. 注册计划任务 RemoteCC-Elevated(RunLevel=Highest,只在被显式拉起时运行)
#
#  跑它需要一次管理员权限(会弹 UAC)—— 所以**你人在电脑前时**跑一次就行,
#  以后 agent 要提权都走手机上的红卡,不再弹框。
#
#  用法:
#      powershell -File deploy\install-elevated-executor.ps1
#      powershell -File deploy\install-elevated-executor.ps1 -AllowFreeCommand   # 见下
#
#  卸载:
#      powershell -File deploy\install-elevated-executor.ps1 -Uninstall
#
#  ⚠️ `-AllowFreeCommand` 会额外打开「执行一条自由命令」这个动作。**默认关着**,
#  而且建议一直关着:开了之后白名单就只剩形式了,每一次都得靠你自己把那行命令读完
#  再决定批不批。它拦得住的是"agent 乱来",拦不住"你没细看就点了批准"。
# ═══════════════════════════════════════════════════════════════════════════════

[CmdletBinding()]
param(
  [switch]$AllowFreeCommand,
  [switch]$Uninstall,
  # 提权子进程用它把输出写回来(见下面自提权那段的说明)。使用者不用传这个参数
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"

$TaskName = "RemoteCC-Elevated"
$TargetDir = Join-Path $env:ProgramData "RemoteCC-Elevated"
# ⚠️ 项目根从**脚本自己的位置**推(`deploy\` 的上一级),不是从当前目录 —— 所以
#    在哪个目录下调用都不影响;但**相对路径** `deploy\install-…ps1` 本身要求当前
#    目录是项目根(`E:\RemoteCC`)。
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$Source = Join-Path $PSScriptRoot "elevated-executor.ps1"

# ── 自提权(和 register-tasks.ps1 / trust-vps-cert.ps1 同一个套路)────────────────
#
# ⚠️ 提权子进程的 stdout **回不到父进程**(见根 CLAUDE.md 坑 12),所以要让它自己
# 写日志、父进程回来读。有两条路,这里走 `Start-Transcript`:
#
#   ① 在 `-ArgumentList` 里塞 `*>&1 | Tee-Object …` —— **不行**。那些是**shell 的**
#      语法,而 `-File` 后面跟的东西一律当**脚本参数**解析 → 脚本收到一堆
#      `*>&1` `|` `Tee-Object` 这样的位置参数,直接报"找不到接受该位置参数的形参"。
#      (第一版就是这么写的,使用者一跑就报错。)
#   ② 把日志路径当中规中矩的参数传进去,子进程自己 `Start-Transcript` —— 走的通。
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Host "需要管理员权限,正在请求提权 —— 请在 UAC 框上点「是」…" -ForegroundColor Yellow
  $log = Join-Path $env:TEMP "remotecc-elevated-install.log"
  Remove-Item $log -ErrorAction SilentlyContinue
  # ⚠️ 只传**规规矩矩的参数**,不要在这里拼 shell 语法(理由见上面那段注释)
  $argList = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", "`"$PSCommandPath`"",
    "-LogPath", "`"$log`""
  )
  if ($AllowFreeCommand) { $argList += "-AllowFreeCommand" }
  if ($Uninstall) { $argList += "-Uninstall" }
  Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs -Wait
  if (Test-Path $log) {
    Get-Content $log
  } else {
    Write-Host "提权那一步什么都没写回来 —— 多半是 UAC 框被取消了(或被系统策略挡下)。" -ForegroundColor Yellow
    Write-Host "也可以自己开一个「以管理员身份运行」的 PowerShell,再跑一次这个脚本。" -ForegroundColor Yellow
  }
  exit 0
}

# 提权子进程:把这一段全部写进 LogPath,父进程回来读(见根 CLAUDE.md 坑 12)
if ($LogPath) {
  try { Start-Transcript -Path $LogPath -Force | Out-Null } catch { }
}

# ── 卸载 ─────────────────────────────────────────────────────────────────────
if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已注销计划任务 $TaskName"
  }
  if (Test-Path $TargetDir) {
    # 目录所有者是 Administrators、当前用户没有写权限 → 只有提权才能删掉它
    Remove-Item -Path $TargetDir -Recurse -Force
    Write-Host "已删除 $TargetDir"
  }
  Write-Host "提权执行器已卸载。deploy\elevate.ps1 现在只会报「任务不存在」。" -ForegroundColor Yellow
  if ($LogPath) { try { Stop-Transcript | Out-Null } catch { } }
  exit 0
}

if (-not (Test-Path $Source)) { throw "找不到 $Source(要在项目的 deploy 目录下跑这个脚本)" }

# ── 1. 目录 + ACL ────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

$me = "$env:USERDOMAIN\$env:USERNAME"
$acl = Get-Acl -Path $TargetDir
# 断开继承并清掉继承来的规则,然后只留三条
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) {
  # 显式转一次类型:集合里的元素静态类型是 AuthorizationRule,RemoveAccessRule 认的是
  # FileSystemAccessRule。不转的话在严格模式下会绑不上那个重载。
  $acl.RemoveAccessRule([System.Security.AccessControl.FileSystemAccessRule]$rule) | Out-Null
}
$inherit = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit"
$none = [System.Security.AccessControl.PropagationFlags]"None"
$allow = [System.Security.AccessControl.AccessControlType]"Allow"
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("BUILTIN\Administrators", "FullControl", $inherit, $none, $allow)))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("NT AUTHORITY\SYSTEM", "FullControl", $inherit, $none, $allow)))
# ⚠️ 当前用户只给**读+执行** —— 不能写、不能删。这是整件事的重点:agent 跑在这个
#    用户下,所以它改不了执行器、改不了白名单、也删不掉审计日志。
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, "ReadAndExecute", $inherit, $none, $allow)))
# ⚠️ 所有者必须改掉。留着当前用户是所有者的话,它能自己把权限改回来(所有者始终有
#    改 DACL 的权利)—— 那前面这几行就白写了。
$acl.SetOwner((New-Object System.Security.Principal.NTAccount("BUILTIN\Administrators")))
Set-Acl -Path $TargetDir -AclObject $acl

Write-Host "目录 ACL 已收紧:$TargetDir" -ForegroundColor Green
Write-Host "  Administrators / SYSTEM = 完全控制,$me = 只读+执行,所有者 = Administrators"

# ── 2. 放执行器 ──────────────────────────────────────────────────────────────
$target = Join-Path $TargetDir "elevated-executor.ps1"
if (Test-Path $target) { Remove-Item $target -Force }   # 升级时要覆盖(现在是管理员,删得掉)
Copy-Item -Path $Source -Destination $target -Force
Write-Host "执行器已就位:$target"

# ── 3. 注册任务 ──────────────────────────────────────────────────────────────
$spool = Join-Path $ProjectRoot "server\data\elevated"
New-Item -ItemType Directory -Force -Path $spool | Out-Null

$freeArg = if ($AllowFreeCommand) { " -AllowFreeCommand" } else { "" }
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$target`" -ProjectRoot `"$ProjectRoot`"$freeArg"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "计划任务已注册:$TaskName(最高权限,只在被显式拉起时运行)" -ForegroundColor Green
Write-Host ""
Write-Host "验一下这条路通不通(手机上应该冒出红色提权卡,批完这里回一句 pong,机器上什么都不改):" -ForegroundColor Cyan
Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\elevate.ps1 -Action ping -Reason '装完自检'"
Write-Host ""
Write-Host "⚠️ 别拿 webclient-restart 当第一次试验:它会重启 WebClient 服务,把 Z: 映射弄掉(还得重挂)。" -ForegroundColor DarkGray
Write-Host "⚠️ 命令里的 -ExecutionPolicy Bypass 别省:这台机器的 Windows PowerShell 5.1 没设过执行策略(默认禁脚本),少了它就报 running scripts is disabled。" -ForegroundColor DarkGray
Write-Host "白名单:ping / cert-trust / webclient-limit / webclient-restart / remotecc-tasks" -ForegroundColor DarkGray
Write-Host "自由命令档位:$(if ($AllowFreeCommand) { '已开启(⚠️ 高风险)' } else { '关闭(推荐)' })"
Write-Host "卸载:powershell -File deploy\install-elevated-executor.ps1 -Uninstall" -ForegroundColor DarkGray

# 提权子进程的日志到此为止 —— 父进程会把它整个打出来
if ($LogPath) { try { Stop-Transcript | Out-Null } catch { } }
