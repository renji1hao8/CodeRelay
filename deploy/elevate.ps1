# ═══════════════════════════════════════════════════════════════════════════════
#  要管理员权限?走这里。
#
#  这是一条**普通权限**就能跑的命令:它把请求写进队列、拉起提权执行器,然后在这儿等 ——
#  等到手机上有人点那张红色提权卡为止。批了,电脑上才真的动手。
#
#  用法:
#      powershell -File deploy\elevate.ps1 -Action webclient-restart -Reason "映射盘下大文件"
#      powershell -File deploy\elevate.ps1 -Action cert-trust -Arg "C:\path\vps.crt" -Reason "装隧道证书"
#      powershell -File deploy\elevate.ps1 -Action webclient-limit -Arg 4294967296 -Reason "放开单文件上限"
#      powershell -File deploy\elevate.ps1 -Action remotecc-tasks -Reason "注册开机任务"
#
#  白名单在 deploy\elevated-executor.ps1 里(装好之后那份在 ProgramData 下,当前用户
#  只读)。要加动作得改那个文件并重跑安装脚本 —— 这是有意的:白名单不该由 agent 改。
#
#  ⚠️ 退出码:0 = 批准并且做成了;1 = 被拒绝 / 超时 / 执行失败(原因打在 stderr)。
#     超时(默认 7 分钟,比后端的 5 分钟宽一点)留给"人没看手机"那种情况。
# ═══════════════════════════════════════════════════════════════════════════════

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Action,
  # 动作的参数:证书路径 / 字节数 / 命令原文(自由命令档)
  [string]$Arg = "",
  # 为什么需要它。会显示在手机上那张卡里 —— **写清楚一点**,那是我判断批不批的依据
  [string]$Reason = "",
  [int]$TimeoutSec = 420,
  # 人在哪一端 —— 决定这一步走「弹本机 UAC」还是「推手机红卡」。
  #   auto(默认)= 读 %LOCALAPPDATA%\cc-presence\where.env,那个文件由 /pc 与 /phone
  #                两个斜杠命令写;**没声明过按 pc 处理**。
  #   pc / phone = **显式覆盖**,压过状态文件(声明过期时用它救急)。
  [ValidateSet("auto", "pc", "phone")][string]$Where = "auto"
)

$ErrorActionPreference = "Stop"

$TaskName = "RemoteCC-Elevated"
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$Spool = Join-Path $ProjectRoot "server\data\elevated"

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  # ⚠️ 用 Write-Host 而不是 Write-Error:脚本开头设了 $ErrorActionPreference = "Stop",
  #    那个设置会**把 Write-Error 变成终止错误** → 使用者看到的是一坨异常栈,而不是
  #    这一句人话。读这行输出的还可能是 agent,给清楚的话比给栈有用。
  Write-Host "提权执行器还没装。请在电脑前跑一次: powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-elevated-executor.ps1" -ForegroundColor Red
  # ⚠️ 那句 -ExecutionPolicy Bypass 不是凑字数:这台机器的 Windows PowerShell 5.1
  #    没设过执行策略(默认 Restricted = 禁脚本),少了它就报
  #    "running scripts is disabled on this system"。PowerShell 7 那边才是 RemoteSigned。
  exit 1
}

New-Item -ItemType Directory -Force -Path $Spool | Out-Null

# ── 人在哪一端:决定走「本机 UAC」还是「手机红卡」 ─────────────────────────────
#
# 状态由斜杠命令 /pc 与 /phone 写进 %LOCALAPPDATA%\cc-presence\where.env。
#
# ⚠️ 为什么读文件、而不是让 agent 传参数:
#    "人在不在电脑前"只有人自己知道。让 agent 去判断(或去猜)必然出错,而猜错的
#    代价很贵 —— 卡推到隔壁房间的手机上,5 分钟后超时,事情没做成。所以那件事由
#    使用者**显式声明**,我们只读结果;读不到就按他的选择默认 pc。
$WhereFile = Join-Path $env:LOCALAPPDATA "cc-presence\where.env"
$declared = ""; $declaredAt = ""
if (Test-Path $WhereFile) {
  foreach ($line in @(Get-Content $WhereFile -ErrorAction SilentlyContinue)) {
    if ($line -match '^where=(.+)$')      { $declared   = $Matches[1].Trim() }
    if ($line -match '^declaredAt=(.+)$') { $declaredAt = $Matches[1].Trim() }
  }
}
if ($Where -eq "auto") {
  $mode = if ($declared) { $declared } else { "pc" }
  $src  = if ($declared) { "由 /$declared 于 $declaredAt 声明" } else { "没声明过 → 默认 pc" }
} else {
  $mode = $Where
  $src  = "命令行 -Where 显式指定"
}
Write-Host "位置:$mode($src)" -ForegroundColor DarkGray

# ⚠️ 这几个动作**无论如何走手机**,人在电脑前也一样。理由:它们动的是根证书 /
#    HKLM 服务参数 / 计划任务(提权持久化)/ 任意命令 —— 都是"一次批准、长期生效"
#    那一类,值得多那一下确认 + 留痕。本机 UAC 那条路不产生审批记录以外的痕迹,
#    而且人在键盘前时点 UAC 是**习惯动作**,风险恰恰在这里。
#    加动作时想清楚它该在哪一栏。
$PhoneOnly = @("cert-trust", "webclient-limit", "remotecc-tasks", "free")

if ($mode -eq "pc" -and ($PhoneOnly -contains $Action)) {
  Write-Host "⚠ $Action 属于高风险动作 → 强制走手机红卡(人在电脑前也一样)。" -ForegroundColor Yellow
  $mode = "phone"
}

if ($mode -eq "pc") {
  # 本地这条路必须起 **ProgramData 里那份**执行器,不能用仓库副本:
  # 审计日志要落在 ACL 收过的目录里(那是整套东西的基石,见安装脚本的说明)。
  $Executor = Join-Path $env:ProgramData "RemoteCC-Elevated\elevated-executor.ps1"
  $supportsLocal = $false
  if (Test-Path $Executor) {
    try { $supportsLocal = (Get-Command $Executor -ErrorAction Stop).Parameters.ContainsKey("Local") } catch { }
  }

  if (-not $supportsLocal) {
    # 优雅降级:装上那份还是旧版(没有 -Local)→ 退回手机那条路。
    # 所以**只改本文件是安全的**,不会把提权弄坏。
    Write-Host "⚠ 已安装的执行器还不支持本地批准(没重装过)→ 这条改走手机红卡。" -ForegroundColor Yellow
    Write-Host "  要启用本机 UAC:在电脑前跑一次 deploy\install-elevated-executor.ps1" -ForegroundColor DarkGray
  } else {
    # ⚠️ 这里的 -Verb RunAs 是**故意的,而且是全机唯一该用它的一处** ——
    #    它本身就是"人在电脑前"那条路的**批准手势**:UAC 框弹在眼前,点一下就是批准。
    #    (别处 —— 尤其 agent —— 一律不许用它:人不在时它够不着,约 2 分钟后自己取消。)
    $resultFile = Join-Path $Spool "local-$([guid]::NewGuid().ToString('N')).json"
    $argList = @(
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", "`"$Executor`"",
      "-ProjectRoot", "`"$ProjectRoot`"",
      "-Local",
      "-Action", $Action,
      "-ResultPath", "`"$resultFile`""
    )
    if ($Arg) { $argList += @("-Arg", "`"$Arg`"") }

    Write-Host "正在弹本机 UAC —— 请在电脑上点「是」。"
    Write-Host "  (不点的话 Windows 约 2 分钟后自己取消,这一步按失败处理;不会改走手机)" -ForegroundColor DarkGray
    try {
      Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs -Wait -ErrorAction Stop
    } catch {
      Write-Host "没批准:UAC 没点或被取消。" -ForegroundColor Red
      Write-Host "  人其实在手机端?先敲 /phone,再加 -Where phone 重跑。" -ForegroundColor Yellow
      exit 1
    }

    if (Test-Path $resultFile) {
      $r = Get-Content -Path $resultFile -Raw -Encoding UTF8 | ConvertFrom-Json
      Remove-Item -Path $resultFile -Force -ErrorAction SilentlyContinue
      if ($r.ok) {
        Write-Host "批准并已完成(本机 UAC)。" -ForegroundColor Green
        if ($r.output) { Write-Host ([string]$r.output) }
        exit 0
      }
      Write-Host "没做成:$($r.error)" -ForegroundColor Red
      exit 1
    }
    # UAC 点过了却没结果 —— 多半是子进程中途炸了。审计在 ACL 收过的那个目录里。
    Write-Host "UAC 点过了,但没拿到执行结果。看审计日志:" -ForegroundColor Red
    Write-Host "  $(Join-Path $env:ProgramData 'RemoteCC-Elevated\audit.log')" -ForegroundColor DarkGray
    exit 1
  }
}

$reqId = [guid]::NewGuid().ToString()

# 谁发起的 —— 手机上那张卡要能看出"这是谁在要权限"。带上工作目录,以及**父进程的
# 命令行**(通常就是 agent 那条命令),那是最有用的一行。
$parentCmd = ""
try {
  $me = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($me.ParentProcessId)"
  $parentCmd = [string]$parent.CommandLine
} catch {
  # 拿不到就算了:这只是给人看的上下文,不该因为查不到就整条失败
}
$caller = "$($PWD.Path)"
if ($parentCmd) { $caller = "$caller`n← $parentCmd" }

@{ reqId = $reqId; action = $Action; arg = $Arg; reason = $Reason; caller = $caller } |
  ConvertTo-Json -Compress |
  Set-Content -Path (Join-Path $Spool "req-$reqId.json") -Encoding UTF8

Write-Host "已排队:$Action —— 正在等手机上的批准(最多 $([math]::Round($TimeoutSec / 60, 1)) 分钟)…"
Start-ScheduledTask -TaskName $TaskName

$resFile = Join-Path $Spool "res-$reqId.json"
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $resFile) {
    $res = Get-Content -Path $resFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Remove-Item -Path $resFile -Force -ErrorAction SilentlyContinue
    if ($res.ok) {
      Write-Host "批准并已完成。" -ForegroundColor Green
      if ($res.output) { Write-Host ([string]$res.output) }
      exit 0
    }
    Write-Host "没有完成:$($res.error)" -ForegroundColor Red
    exit 1
  }
  Start-Sleep -Milliseconds 800
}

Write-Host "等超时了($TimeoutSec 秒)。手机上那张卡可能还在,也可能已经按拒绝处理了 —— 需要的话重跑一次。" -ForegroundColor Red
exit 1
