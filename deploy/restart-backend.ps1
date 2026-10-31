<#
.SYNOPSIS
  重启后端(带延迟)。**一律用这个脚本重启后端,不要手工杀进程再手工起。**

.DESCRIPTION
  为什么要有"延迟"这一档:后端一停,已连的手机流当场断掉。而重启这个动作常常是
  **在回复使用者的同一条消息里**发起的("改完了,我重启一下")—— 立即重启会把
  那条回复连同连接一起掐掉,使用者看到的是"说到一半没了"。所以先等一会儿
  (默认 20 秒)再动手,留给当前这一轮把话说完、把消息送到手机。

  其他两个必须守住的点:

  1. **环境变量要在这里重新注入**。后端读的是 `process.env`,而 `Start-Process`
     继承的是**当前进程**的环境 —— 只改 `config.ps1` 而不在这里注入,等于没改。
     详见 CLAUDE.md「环境变量完整清单」。
  2. **起法与 `bootstrap.ps1` 保持一致**(`node src\index.ts`,输出追加到
     `server.out.log`)。不一致会让日志分叉,排查时两边都看不全。

  停的是**后端整棵树**:后端自己 **+ 它拉起的 claude 会话进程**(见
  `Stop-Descendants` 那段说明 —— Windows 不会连带杀子进程,留下孤儿会变成两个进程
  写同一份 jsonl)。不碰 mihomo / cc-switch。

.PARAMETER DelaySeconds
  等多少秒再动手。默认 20。给 0 就是立刻。

.PARAMETER Detached
  **内部用**:由 `restart-backend-later.ps1` 传进来 —— 表示"调用方已经脱身了,别拦我"。
  手跑时**不要**加它(加上就等于跳过下面那条守卫)。

.EXAMPLE
  powershell -File deploy/restart-backend.ps1
  powershell -File deploy/restart-backend.ps1 -DelaySeconds 0
#>
param([int]$DelaySeconds = 20, [switch]$Detached, [switch]$InspectOnly)

. "$PSScriptRoot\config.ps1"
. "$PSScriptRoot\rotate-logs.ps1"

$BootLog = Join-Path $LogDir "boot.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
    Add-Content -Path $BootLog -Value $line -Encoding UTF8
}

function Test-Port {
    param([int]$Port, [string]$TargetHost = "127.0.0.1", [int]$TimeoutMs = 800)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($TargetHost, $Port, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne($TimeoutMs)) {
            $client.EndConnect($async)
            return $true
        }
        return $false
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

<#
  收掉某个进程名下的**所有后代**。

  为什么必须显式做:Windows 里杀父进程**不会**连带杀子进程。所以只 Stop-Process
  后端的话,它拉起来的 claude 会话进程会变成孤儿继续跑 —— 后果很实际:新后端的
  会话表是空的,手机重进那个会话会**再起一个** `claude --resume` 读同一份 jsonl,
  于是两个进程同时往同一个会话文件里追写(而 jsonl 是权威源,写坏了没得恢复)。
  卡住不退出那种就是更常见的来源 —— 它永远不会自己结束。

  ⚠️ 只按**父子关系**收,不按名字收:机器上还有别的 claude(桌面上开着的、
  别的终端里的),按名字杀会误伤。
#>
function Stop-Descendants([int]$RootPid) {
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    $byParent = @{}
    foreach ($p in $all) {
        $ppid = [int]$p.ParentProcessId
        if (-not $byParent.ContainsKey($ppid)) { $byParent[$ppid] = @() }
        $byParent[$ppid] += $p
    }

    # 广度优先把所有后代收集齐(不能边遍历边杀:杀掉的进程会让 CIM 查询变化)
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($RootPid)
    $found = @()
    while ($queue.Count -gt 0) {
        $cur = [int]$queue.Dequeue()
        foreach ($child in $byParent[$cur]) {
            $queue.Enqueue([int]$child.ProcessId)
            $found += $child
        }
    }

    foreach ($p in $found) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    return $found.Count
}

<#
  $Pid 是不是 $AncestorPid 的后代(含自己)。

  守卫用(见下面 -Detached 那段):调用方就在后端那棵树里的话,这个脚本会先杀掉调用它的
  会话、再杀掉自己,后端反而停在旧代码上。要先认出来、拒绝、说清楚。
#>
function Test-IsDescendant {
    param([int]$AncestorPid, [int]$ChildPid)
    # ⚠️ 第二个参数**不能叫 `$Pid`**:PowerShell 变量名不分大小写,`$Pid` 就是那个只读的
    #    自动变量 `$PID` → 参数绑不上,报"无法覆盖变量 Pid,因为它是只读变量或常量",
    #    而这是个**非终止错误**:守卫那一行于是判成 false、静默放行 —— 也就等于没有守卫,
    #    脚本照旧把自己收掉。(和坑 11「别用 `H` 当函数名」是同一类毛病。)
    $byPid = @{}
    foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $byPid[[int]$p.ProcessId] = [int]$p.ParentProcessId
    }
    $cur = $ChildPid
    for ($i = 0; $i -lt 32; $i++) {
        if ($cur -eq $AncestorPid) { return $true }
        if (-not $byPid.ContainsKey($cur)) { return $false }
        $next = $byPid[$cur]
        if ($next -eq 0 -or $next -eq $cur) { return $false }
        $cur = $next
    }
    return $false
}

Write-Log "===== 重启后端(延迟 $DelaySeconds 秒)====="

# 用监听端口反查 PID,而不是按名字杀 node.exe —— 机器上还有别的 node(比如
# 我自己的工具进程),按名字杀会误伤。
$pids = @(
    Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
)

# Windows can omit a still-serving listener from its Listen table. Only use a
# local-port owner as fallback after checking both the executable and entrypoint.
# Never fall back to stopping all node.exe processes.
if ($pids.Count -eq 0) {
    $candidateIds = @()
    foreach ($line in (& netstat.exe -ano -p tcp)) {
        $columns = $line.Trim() -split '\s+'
        if ($columns.Count -lt 5 -or $columns[0] -ne 'TCP') { continue }
        if (-not $columns[1].EndsWith(":" + $BackendPort)) { continue }
        $ownerId = 0
        if ([int]::TryParse($columns[4], [ref]$ownerId) -and $ownerId -gt 0) { $candidateIds += $ownerId }
    }
    $verifiedIds = @()
    foreach ($ownerId in ($candidateIds | Select-Object -Unique)) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId" -ErrorAction SilentlyContinue
        if (-not $owner -or $owner.ExecutablePath -ne $NodeExe) { continue }
        $relativeEntry = $owner.CommandLine -match '(?i)(?:^|\s|")src[\\/]index\.ts(?:\s|"|$)'
        $absoluteEntry = $owner.CommandLine -like ('*' + (Join-Path $ServerDir 'src\index.ts') + '*')
        if ($relativeEntry -or $absoluteEntry) { $verifiedIds += [int]$owner.ProcessId }
    }
    $pids = @($verifiedIds | Select-Object -Unique)
    if ($pids.Count -gt 0) { Write-Log "监听表漏报，已按本地端口及 Node 入口核验后端 PID=$($pids -join ',')" }
}
if ($InspectOnly) {
    Write-Log "只读检查结束；识别到 $($pids.Count) 个后端进程，未停止或启动进程"
    exit 0
}

# ---- 0) 守卫:调用方是不是就在后端那棵树里 ----
#
# ⚠️ 这条守卫是**用血换来的**:`Stop-Descendants` 收的是后端的全部后代,而从手机客户端的
#    会话里调这个脚本时,**调用它的那个 claude 进程本身就是后端的子进程** —— 于是它先杀掉
#    那个会话、再收到自己身上:脚本当场死掉,`Start-Process` 那一步永远走不到,
#    **后端还停在旧代码上**。表现极具误导性:boot.log 里只留一行 `===== 重启后端 =====` 头,
#    会话却断了一次,人以为"重启过了"(2026-09-20 22:16~22:26 连踩四次,2026-09-21 又三次)。
#
#    正确做法是**先脱身再动手**:用 `deploy/restart-backend-later.ps1` —— 它起一个独立
#    进程后立刻返回,那个进程不在被杀的集合里。它调过来时会带 -Detached 跳过这条守卫。
if (-not $Detached -and $pids.Count -gt 0 -and (Test-IsDescendant -AncestorPid $pids[0] -ChildPid $PID)) {
    Write-Log "❌ 拒绝执行:这个脚本是在**后端那棵树**里被调起的(多半是从手机客户端的会话里跑它)。"
    Write-Log "   现在动手的话,它会先杀掉调用它的那个会话(那个 claude 正是后端的子进程),"
    Write-Log "   再收到自己身上 —— 脚本当场死掉、后端停在旧代码上,而 boot.log 里只留一行头。"
    Write-Log "   ✅ 要重启请用这个(先脱身再动手,所以哪怕会话被杀了后端照样能起来):"
    Write-Log "      powershell -NoProfile -ExecutionPolicy Bypass -File deploy/restart-backend-later.ps1"
    exit 1
}

if ($DelaySeconds -gt 0) {
    Write-Log "先等 $DelaySeconds 秒 —— 留给当前这一轮把回复送到手机"
    Start-Sleep -Seconds $DelaySeconds
}

# ---- 1) 停 ----
if ($pids.Count -gt 0) {
    foreach ($p in $pids) {
        # ⚠️ 先收后代、再收自己。Windows 不会连带杀子进程,后端名下挂着的正是它拉起的
        # claude 会话进程 —— 留一个下来,新后端重进那个会话时会再起一个,两个进程写
        # 同一份 jsonl。详见 Stop-Descendants 上面的说明。
        $n = Stop-Descendants $p
        if ($n -gt 0) {
            Write-Log "  连带收掉 $n 个后代进程(不收的话它们会变成孤儿,继续写同一个会话文件)"
        }
        Write-Log "停掉后端 PID=$p"
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    }
    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Test-Port -Port $BackendPort)) { break }
    }
} else {
    Write-Log ":$BackendPort 上没有监听进程,直接起"
}

if (Test-Port -Port $BackendPort) {
    Write-Log "❌ 端口 $BackendPort 仍被占用,起不来。先跑 deploy/cleanup-orphans.ps1 看是谁占着"
    exit 1
}

# ---- 2) 起(与 bootstrap.ps1 那段一致)----
if (-not (Test-Path $NodeExe)) {
    Write-Log "❌ 找不到 node:$NodeExe"
    exit 1
}

$serverOut = Join-Path $LogDir "server.out.log"
$cmdLine = "/c `"`"$NodeExe`" src\index.ts >> `"$serverOut`" 2>&1`""

# 切日志。走到这里旧后端已经被收掉了,句柄是松的 —— 唯一安全的时机(见 rotate-logs.ps1)
$rotated = Rotate-LogFile -Path $serverOut
if ($rotated) { Write-Log "日志:$rotated" }

$env:REMOTE_CC_PUBLIC_URL = $PublicUrl
$env:REMOTE_CC_READONLY_ROOTS = $ReadOnlyRoots
$env:REMOTE_CC_LIST_DIR = $ListDir

Start-Process -FilePath "cmd.exe" -ArgumentList $cmdLine -WorkingDirectory $ServerDir -WindowStyle Hidden

$ok = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Port -Port $BackendPort) { $ok = $true; break }
}

if (-not $ok) {
    Write-Log "❌ 后端启动失败,详见 $serverOut"
    exit 1
}

Write-Log "后端已起来(:$BackendPort)"
if ($PublicUrl) { Write-Log "手机地址:$PublicUrl" }
Write-Log "⚠️ 手机上的 App 需要重新进一次会话 —— 旧的那条流已经断了"
Write-Log "===== 重启后端结束 ====="
