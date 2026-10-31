# 日志切割 —— bootstrap 与 restart-backend 都要用,所以单独一份。
# 两处各写一遍的话,阈值或保留份数必然会走偏,而那时候没人会去对。
#
# ## 为什么是"启动时"切
#
# 后端是 `cmd /c "node src\index.ts >> server.out.log 2>&1"` 起的 —— 那个文件句柄
# 在 cmd.exe 手里,**进程活着的时候谁也挪不动它**(Windows 上对打开中的文件改名直接失败)。
# 而"正要启动后端"的那一刻,旧进程刚好已经不在了:这是唯一安全的时机。
# 真的挪不动就**这次不切**,不新建文件、也不截断 —— 继续追加,总比把这段日志丢掉好。
#
# ## 为什么需要
#
# 2026-10-13 那份 `server.out.log` 已经 **11 MB**。排查的时候真正用得到的只有尾巴
# 几百行(做任何一次现场分析都是 `tail` / 按时间戳截一段),而它每次重启都继续往后追加。
# 按大小切 + 只留最近几份:**历史一点没少,查找反而变快**,磁盘占用还有上界。
#
# ⚠️ 顺带说明**为什么不改成降低日志级别**:Fastify 那两行 `incoming request` /
# `request completed` 看着啰嗦,但它们带 `reqId` 与毫秒时间戳 —— 2026-10-13 那次
# 把"后端 19:20:29 崩"与"frpc 19:20:30 开始报错"对齐,靠的就是它们。关掉之后
# 日志会安静很多,而下一次再出事就只能靠猜了。切割解决的是体积,不是信息量。

function Rotate-LogFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$MaxBytes = 10MB,
        [int]$Keep = 5
    )

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -lt $MaxBytes) { return $null }

    $dir = Split-Path -Parent $Path
    $base = [IO.Path]::GetFileNameWithoutExtension($Path)   # 例如 server.out
    $dest = Join-Path $dir ("{0}.{1}.log" -f $base, (Get-Date -Format "yyyyMMdd-HHmmss"))

    try {
        Move-Item -LiteralPath $Path -Destination $dest -ErrorAction Stop
    } catch {
        return ("切不动(句柄还占着),本次跳过:{0:N1} MB" -f ($item.Length / 1MB))
    }

    # 只留最近 Keep 份。带时间戳的名字按字典序排就是按时间排。
    $pattern = "^" + [Regex]::Escape($base) + "\.\d{8}-\d{6}\.log$"
    $old = @(Get-ChildItem -LiteralPath $dir -Filter ("{0}.*.log" -f $base) -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $pattern } |
        Sort-Object Name)

    $removed = 0
    if ($old.Count -gt $Keep) {
        foreach ($f in $old[0..($old.Count - $Keep - 1)]) {
            Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
            $removed++
        }
    }

    $tail = if ($removed -gt 0) { ",删掉 $removed 份旧的,保留 $Keep 份" } else { "" }
    return ("已切:{0} → {1}({2:N1} MB){3}" -f $base, (Split-Path -Leaf $dest), ($item.Length / 1MB), $tail)
}
