# ═══════════════════════════════════════════════════════════════════════════════
#  RemoteCC 提权执行器
#
#  由计划任务 `RemoteCC-Elevated` 以**最高权限**拉起,做两件事:
#    1. 把这批请求问一遍手机(后端 /api/elevated/request 会一直挂着等手机上的决定)
#    2. 手机批了才动手 —— 而且只做**白名单里**的那几个动作
#
#  为什么要有它:agent 跑需要管理员权限的命令时会弹 UAC,而那个框在电脑的
#  secure desktop 上,手机上看不到也点不着,那一轮就静默挂住。这个执行器把那一下
#  换成"手机上的一张红卡"。
#
#  ⚠️ 这个文件**必须**放在一个当前用户没有写权限的目录里(见 install-elevated-executor.ps1
#  里的 ACL 设置)。否则被提示注入的 agent 可以把这个白名单改掉,那这道闸门就没了。
#
#  ⚠️ 安全边界(别把它当硬闸门):它拦得住"agent 自作主张提权"—— agent 就算直接
#  去 Start-ScheduledTask,拿到的也只是"一张等手机点的红卡"。它拦不住"冒充手机来
#  批准":后端与 agent 同机同用户,能读这台机器上任何文件的东西理论上也能自己走一遍
#  配对拿到 token 再自己点批准。要堵死那一条得靠手机侧私钥签名(电脑上读不到私钥),
#  那是下一步的事。
# ═══════════════════════════════════════════════════════════════════════════════

[CmdletBinding()]
param(
  # 项目根(包装脚本写请求、执行器写结果都在这下面的 server\data\elevated)
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  # 后端地址(提权请求要问它,由它推给手机)
  [string]$Backend = "http://127.0.0.1:8787",
  # 是否允许「自由命令」这个动作。默认**关** —— 开了它,白名单就只剩形式了,
  # 每次都得你自己读那行命令。见下面 $AllowFreeCommand 的说明。
  [switch]$AllowFreeCommand,
  # ── 本地批准通道(2026-09-21 加)─────────────────────────────────────────────
  # 传了 `-Local` = 「这一步的批准**已经发生过了**」,不需要再问手机。
  # **批准动作就是使用者刚在本机 UAC 框上点的那一下** —— 由 deploy\elevate.ps1 在
  # "人在电脑前"那条路上,以 RunAs 起本脚本并带上它。
  #
  # ⚠️ 它绕过的是「问手机」那一步,不是「白名单」那一步 —— 下面照样卡白名单,
  #    照样写审计。能起这个进程的前提是**有人在 UAC 上点过**,所以闸门只是从
  #    "手机那一下"换成"UAC 那一下",不是没有闸门。
  # ⚠️ 因此**只有 elevate.ps1 该用它**。agent 自己去 Start-ScheduledTask 拿到的是
  #    原先那条路(等手机红卡),拿不到这个开关。
  [switch]$Local,
  # 本地模式要做的动作与参数(只在 -Local 下有意义)
  [string]$Action = "",
  [string]$Arg = "",
  # 本地模式把结果写到哪 —— 提权子进程的 stdout 回不到父进程(见根 CLAUDE.md 坑 12),
  # 所以走文件,和队列那条路的 res-*.json 一个道理。
  [string]$ResultPath = ""
)

$ErrorActionPreference = "Stop"

$Spool = Join-Path $ProjectRoot "server\data\elevated"
$AuditLog = Join-Path $PSScriptRoot "audit.log"
$AllowFree = [bool]$AllowFreeCommand

New-Item -ItemType Directory -Force -Path $Spool | Out-Null

function Write-Audit([string]$line) {
  $stamp = (Get-Date).ToString("s")
  Add-Content -Path $AuditLog -Value "$stamp  $line" -Encoding UTF8
}

# ── 白名单 ────────────────────────────────────────────────────────────────────
# 三个动作各自一块:标题(显示在手机上)、细节(具体做什么)、以及真正动手的那一段。
# ⚠️ 加动作时**三处都要加**(标题 / 细节 / 执行),漏一处的表现是"手机上显示了个
#    空白动作"或者"批了却什么都没做"。

function Get-ActionTitle([string]$action) {
  switch ($action) {
    "ping"              { "什么都不做(自检这条路通不通)" }
    "cert-trust"        { "把证书装进「受信任的根证书颁发机构」" }
    "webclient-limit"   { "放大 WebClient 单文件上限(映射盘大文件下载)" }
    "webclient-restart" { "重启 WebClient 服务" }
    "remotecc-tasks"    { "注册 RemoteCC 那三个计划任务" }
    "free"              { if ($AllowFree) { "执行一条自由命令(高风险)" } else { $null } }
    default             { $null }
  }
}

function Get-ActionDetail([string]$action, [string]$arg) {
  switch ($action) {
    # 装完想验一下这条路通不通就跑它:手机上会正常冒红卡、批完之后这里回一句 pong,
    # 而机器上**什么都不改**。别的动作都有副作用:比如 webclient-restart 会把 Z: 映射弄掉。
    "ping"              { "不碰机器上的任何东西。只用来验「请求 → 红卡 → 批准 → 回话」这条链" }
    "cert-trust"        { "导入证书到 LocalMachine\Root:`n$arg" }
    # 字节数换算成人看的单位 —— 手机上看到 "FileSizeLimitInBytes=4294967296" 不如
    # 看到 "4.0 GB" 更容易判断这一步该不该批
    "webclient-limit"   { "HKLM:\SYSTEM\CurrentControlSet\Services\WebClient\Parameters\FileSizeLimitInBytes = $arg  ($([math]::Round([int64]$arg/1GB,2)) GB)" }
    "webclient-restart" { "Restart-Service WebClient" }
    "remotecc-tasks"    { "以管理员身份运行 $ProjectRoot\deploy\register-tasks.ps1" }
    "free"              { if ($AllowFree) { "以管理员身份执行:`n$arg" } else { $null } }
    default             { $null }
  }
}

function Invoke-Action([string]$action, [string]$arg) {
  switch ($action) {
    "ping" { return "pong —— 这条路是通的(机器上什么都没改)" }
    "cert-trust" {
      $out = Import-Certificate -FilePath $arg -CertStoreLocation Cert:\LocalMachine\Root | Out-String
      return $out
    }
    "webclient-limit" {
      $key = "HKLM:\SYSTEM\CurrentControlSet\Services\WebClient\Parameters"
      Set-ItemProperty -Path $key -Name FileSizeLimitInBytes -Value ([int64]$arg) -Type DWord
      Restart-Service WebClient
      return "已设为 $arg 并重启 WebClient"
    }
    "webclient-restart" {
      Restart-Service WebClient
      return "WebClient 已重启"
    }
    "remotecc-tasks" {
      $script = Join-Path $ProjectRoot "deploy\register-tasks.ps1"
      if (-not (Test-Path $script)) { throw "找不到 $script" }
      # 已经是管理员了,那个脚本会跳过它自己的自提权那一段
      $out = & $script 2>&1 | Out-String
      return $out
    }
    "free" {
      if (-not $AllowFree) { throw "「自由命令」没开(装上时没带 -AllowFreeCommand)" }
      # ⚠️ 这里就是那个"闸门焊死"的位置:一行任意命令、以管理员身份跑。默认关着是有意的。
      $out = & powershell.exe -NoProfile -Command $arg 2>&1 | Out-String
      return $out
    }
    default { throw "白名单里没有这个动作:$action" }
  }
}

# ── 处理一个请求 ──────────────────────────────────────────────────────────────

function Invoke-One {
  param([hashtable]$Req)

  $reqId = [string]$Req.reqId
  $action = [string]$Req.action
  $arg = if ($Req.arg) { [string]$Req.arg } else { "" }

  Write-Audit "请求 $reqId  动作=$action  发起=$($Req.caller)"

  # 不在白名单里 → 连问都不问手机,直接回绝(问一张注定要被拒的卡只会浪费人一次注意力)
  $title = Get-ActionTitle $action
  if (-not $title) {
    $result = @{ reqId = $reqId; ok = $false; error = "动作不在白名单里:$action" }
    $result | ConvertTo-Json -Compress | Set-Content -Path (Join-Path $Spool "res-$reqId.json") -Encoding UTF8
    Write-Audit "→ 拒绝(不在白名单)"
    return
  }

  $detail = Get-ActionDetail $action $arg
  # 谁发起的:带上工作目录和发起进程的父命令行 —— 手机上那张卡要能看出"这是谁在要权限"
  $caller = if ($Req.caller) { [string]$Req.caller } else { "未知" }
  $reason = if ($Req.reason) { [string]$Req.reason } else { "" }

  $decision = "deny"
  $note = ""
  try {
    $body = @{
      action = $action; title = $title; detail = $detail
      caller = $caller; reason = $reason
    } | ConvertTo-Json -Compress -Depth 3

    # ⚠️ 这一句会**一直挂着等手机上的人点**(后端自己 5 分钟超时)→ 客户端超时给足 6 分钟
    $resp = Invoke-RestMethod -Method Post -Uri "$Backend/api/elevated/request" `
      -ContentType "application/json; charset=utf-8" `
      -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
      -TimeoutSec 360

    $decision = [string]$resp.decision
    $note = [string]$resp.note
  }
  catch {
    $note = "问不到后端($($_.Exception.Message))—— 按拒绝处理"
    $decision = "deny"
  }

  if ($decision -ne "approve") {
    Write-Audit "→ 手机没批($decision) $note"
    @{ reqId = $reqId; ok = $false; error = "没有批准。$note" } |
      ConvertTo-Json -Compress | Set-Content -Path (Join-Path $Spool "res-$reqId.json") -Encoding UTF8
    return
  }

  Write-Audit "→ 手机批准了,开始执行"
  try {
    $output = Invoke-Action $action $arg
    Write-Audit "→ 成功:$($output -replace '\s+',' ' | Select-Object -First 1)"
    @{ reqId = $reqId; ok = $true; output = [string]$output } |
      ConvertTo-Json -Compress | Set-Content -Path (Join-Path $Spool "res-$reqId.json") -Encoding UTF8
  }
  catch {
    Write-Audit "→ 失败:$($_.Exception.Message)"
    @{ reqId = $reqId; ok = $false; error = [string]$_.Exception.Message } |
      ConvertTo-Json -Compress | Set-Content -Path (Join-Path $Spool "res-$reqId.json") -Encoding UTF8
  }
}

# ── 本地批准通道(一次性模式)──────────────────────────────────────────────────
#
# `elevate.ps1` 在「人在电脑前」时以 **RunAs** 起本脚本、带上 `-Local` 与要做的动作。
# 不打搅手机 —— 批准凭据是使用者刚在 UAC 框上点的那一下。
#
# ⚠️ 白名单**照样卡**:不在白名单里的动作,本地这条路一样做不了。
# ⚠️ 结果写文件,因为提权子进程的 stdout 回不到父进程(见根 CLAUDE.md 坑 12)。

if ($Local) {
  Write-Audit "本地模式(UAC 批准,不经手机):$Action"

  function Write-LocalResult([bool]$ok, [string]$output, [string]$error) {
    if (-not $ResultPath) { return }
    $o = @{ ok = $ok }
    if ($ok) { $o.output = $output } else { $o.error = $error }
    $o | ConvertTo-Json -Compress | Set-Content -Path $ResultPath -Encoding UTF8
  }

  $title = Get-ActionTitle $Action
  if (-not $title) {
    # 不在白名单 —— 本机这条也一样当场回绝(改白名单得人在电脑前重跑安装脚本)
    Write-Audit "→ 拒绝(不在白名单)"
    Write-LocalResult $false "" "动作不在白名单里:$Action"
    exit 1
  }

  try {
    $output = Invoke-Action $Action $Arg
    Write-Audit "→ 成功:$($output -replace '\s+',' ' | Select-Object -First 1)"
    Write-LocalResult $true ([string]$output) ""
    exit 0
  } catch {
    Write-Audit "→ 失败:$($_.Exception.Message)"
    Write-LocalResult $false "" ([string]$_.Exception.Message)
    exit 1
  }
}

# ── 主循环 ────────────────────────────────────────────────────────────────────
#
# 一次拉起把所有没答完的请求都处理掉,处理完就退出。
# ⚠️ 计划任务的"多个实例"策略默认是 IgnoreNew(见安装脚本没去改它)→ 不会有两个
# 执行器同时跑,所以这里一个个顺着处理是安全的。

$processed = 0
while ($true) {
  $reqs = @(Get-ChildItem -Path $Spool -Filter "req-*.json" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending)
  $next = $null
  foreach ($f in $reqs) {
    $id = $f.BaseName.Substring(4)
    if (-not (Test-Path (Join-Path $Spool "res-$id.json"))) { $next = $f; break }
  }
  if (-not $next) { break }

  try {
    $req = Get-Content -Path $next.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    # ⚠️ 这里必须写 `-Req`。直接写 `Invoke-One @{…}` 在 PowerShell 里是**按名字展开**
    # (splatting):它会去找名叫 reqId / action / arg … 的**形参**,而它们不存在 →
    # 报"找不到接受该参数名的形参"。函数只有 `$Req` 一个形参,所以得指名给它。
    Invoke-One -Req @{ reqId = $req.reqId; action = $req.action; arg = $req.arg; caller = $req.caller; reason = $req.reason }
  }
  catch {
    Write-Audit "请求文件读不动($($next.Name)):$($_.Exception.Message)"
  }
  finally {
    # 请求用完就删:同一个请求不能被处理第二遍(重放)
    Remove-Item -Path $next.FullName -Force -ErrorAction SilentlyContinue
  }
  $processed++
}

if ($processed -eq 0) { Write-Audit "被拉起,但没有待处理的请求" }
