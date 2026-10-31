<#
.SYNOPSIS
  隔一段时间再重启后端 —— **给"我还在说话"这一种情况用**。

.DESCRIPTION
  为什么要单独一个脚本:`restart-backend.ps1` 自己是带 `-DelaySeconds` 的,但那个延迟
  只在它被**同步调用**时有意义。如果由 agent 在自己的回合里同步跑它,那个回合根本活不过
  这次重启 —— 因为**手机上的会话就是后端的 claude 子进程**,而 agent 正在那条会话里说话。
  实际结果是:延迟睡了、后端重启了、回复一个字都没送出去。使用者 2026-09-20 看到的就是
  「说到一半没了」,后面还跟着几句空的回复。

  所以这里做的是**脱离父进程**:用 `Start-Process` 起一个完全独立的小进程,它先睡够,
  再调 `restart-backend.ps1 -DelaySeconds 0`。调用方(agent 的回合)可以**立刻返回**,
  把话说完;两分钟后再由那个独立进程动手。

  什么时候用哪个:
    - 人在电脑前、自己手动重启        → `deploy/restart-backend.ps1`(同步,带 20 秒默认延迟)
    - agent 要重启、而它正通过手机说话 → **这个**(异步,先脱身)

.PARAMETER DelaySeconds
  多少秒后动手。默认 120 —— 比同步版那个 20 秒宽得多,因为这里要留的不只是"这一句话
  送到手机",还要留出使用者**读完并回一句**的时间。

.EXAMPLE
  powershell -File deploy/restart-backend-later.ps1
  powershell -File deploy/restart-backend-later.ps1 -DelaySeconds 30
#>
param([int]$DelaySeconds = 120)

$target = Join-Path $PSScriptRoot "restart-backend.ps1"
if (-not (Test-Path $target)) {
    Write-Host "找不到 $target"
    exit 1
}

<#
  ⚠️ `-Detached` 不能省。

  `restart-backend.ps1` 里加了一条守卫:调用方如果是**后端那棵树**里的进程就拒绝执行
  (因为那样它会先杀掉调用它的会话、再收到自己身上,后端反而停在旧代码上 ——
  2026-09-20~21 静默失败过七次,而 boot.log 里只留一行头)。

  我们**确实是**从树里被间接调起的(这个独立进程由会话里的 pwsh 起出来),但我们的特殊
  之处在于:**启动我们的那个进程早就退出了**,于是我们被"悬挂"到那棵树之外 ——
  `Stop-Descendants` 按父子关系走,走不到一个父进程已经死掉的孤儿。

  所以这个标记的含义是"调用方已经确认脱身了,别拦",不是"跳过安全检查"。
#>
Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"'+$target+'"'), "-DelaySeconds", [string]$DelaySeconds, "-Detached") `
    -WindowStyle Hidden

Write-Host "已排定:$DelaySeconds 秒后重启后端(独立进程,不受当前会话断开影响)"
Write-Host "⚠️ 重启后手机上要重新进一次会话 —— 旧的那条流会断"
