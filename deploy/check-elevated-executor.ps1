# ═══════════════════════════════════════════════════════════════════════════════
#  离线自测:提权执行器的**白名单闸门**
#
#  验的是一句最要紧的话:**不在白名单里的动作,连问都不问手机,当场回绝**。
#  问一张注定要被拒的卡只会浪费人一次注意力;而"白名单外也能过"就等于这道闸门没了。
#
#  它**不需要 UAC、不需要后端、不需要手机** —— 把执行器拷到临时目录、拿一个假的
#  项目根跑一遍,全程只落文件。所以随时能跑,不打扰任何人。
#
#  用法(在项目根或 deploy 下都行):
#
#      powershell -ExecutionPolicy Bypass -File deploy\check-elevated-executor.ps1
#
#  退出码即结论(0 = 全过)。跑完自己清理临时目录。
# ═══════════════════════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"

$failures = 0
function Check([string]$name, [bool]$ok, [string]$detail = "") {
  if ($ok) {
    Write-Host "  ✓ $name" -ForegroundColor Green
  } else {
    Write-Host "  ✗ $name$(if ($detail) { "  — $detail" })" -ForegroundColor Red
    $script:failures += 1
  }
}

$executor = Join-Path $PSScriptRoot "elevated-executor.ps1"
if (-not (Test-Path $executor)) { throw "找不到 $executor" }

$tmp = Join-Path $env:TEMP ("rc-elev-check-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$spool = Join-Path $tmp "server\data\elevated"
New-Item -ItemType Directory -Force -Path $spool | Out-Null
Copy-Item -Path $executor -Destination $tmp -Force

try {
  # ---- 1. 放一个"白名单外"的请求进去 ----
  $reqId = "check-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  @{
    reqId = $reqId; action = "definitely-not-in-whitelist"; arg = ""; caller = "check-elevated-executor.ps1"
    reason = "这条应该被当场拒掉"
  } | ConvertTo-Json -Compress | Set-Content -Path (Join-Path $spool "req-$reqId.json") -Encoding UTF8

  & (Join-Path $tmp "elevated-executor.ps1") -ProjectRoot $tmp | Out-Null

  $resPath = Join-Path $spool "res-$reqId.json"
  Check "白名单外的请求留下了结果文件" (Test-Path $resPath)

  if (Test-Path $resPath) {
    $res = Get-Content -Path $resPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Check "结果是「没做成」" ($res.ok -eq $false)
    Check "理由说清了是白名单" ([string]$res.error -match "白名单")
  }

  Check "请求文件用完就删了(同一请求不能被处理第二遍)" (-not (Test-Path (Join-Path $spool "req-$reqId.json")))

  # ---- 1b. 白名单**里**的动作:该走到"问后端"那一步(而不是当场被拒) ----
  #
  # ⚠️ 这里把后端指到一个**死端口**,于是它必然卡在"问不到后端 → 按拒绝处理"。
  #    这样验的是"ping 确实在白名单里"(否则报的是"不在白名单")、以及**问不到后端时
  #    不会硬着头皮往下做** —— 而全程不会往任何人的手机上推红卡。
  $reqId2 = "check-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  @{ reqId = $reqId2; action = "ping"; arg = ""; caller = "check"; reason = "验白名单命中" } |
    ConvertTo-Json -Compress | Set-Content -Path (Join-Path $spool "req-$reqId2.json") -Encoding UTF8
  & (Join-Path $tmp "elevated-executor.ps1") -ProjectRoot $tmp -Backend "http://127.0.0.1:9" | Out-Null
  $resPath2 = Join-Path $spool "res-$reqId2.json"
  Check "白名单里的动作留下了结果文件" (Test-Path $resPath2)
  if (Test-Path $resPath2) {
    $res2 = Get-Content -Path $resPath2 -Raw -Encoding UTF8 | ConvertFrom-Json
    Check "它走到了「问后端」那一步(不是当场被白名单拒掉)" ([string]$res2.error -notmatch "不在白名单")
    Check "问不到后端 → 按拒绝处理(不会硬着头皮做)" ($res2.ok -eq $false -and [string]$res2.error -match "问不到后端")
  }

  # ---- 2. 审计日志:ACL 收过的目录里的那个——这里只是验它写了 ----
  $audit = Join-Path $tmp "audit.log"
  Check "审计日志写了" (Test-Path $audit)
  if (Test-Path $audit) {
    $text = Get-Content -Path $audit -Raw -Encoding UTF8
    Check "审计里记下了这个动作名" ($text -match "definitely-not-in-whitelist")
    Check "审计里记下了「拒绝」" ($text -match "拒绝")
  }

  # ---- 3. 再跑一次:没有请求了,应该什么都没做就退出(幂等) ----
  & (Join-Path $tmp "elevated-executor.ps1") -ProjectRoot $tmp | Out-Null
  $audit2 = Get-Content -Path $audit -Raw -Encoding UTF8
  Check "第二次跑:报告「没有待处理的请求」" ($audit2 -match "没有待处理的请求")
} finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($failures -eq 0) {
  Write-Host "全部通过" -ForegroundColor Green
} else {
  Write-Host "$failures 项未通过" -ForegroundColor Red
}
exit $failures
