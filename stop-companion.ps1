# 停掉托管驱动器（连同它启动的 claude / agy 和 MCP 服务端，小克会下线）
# 用法：.\stop-companion.ps1           （小克）
#       .\stop-companion.ps1 Gemini    （小双）
# 做法：先放一个停止标记，驱动器看到后自己正常退出（关掉 agent、删心跳和锁）；
#       超时还没退，就用 taskkill 结束整个进程树。
param(
    [string]$Name = 'Claude',
    [int]$TimeoutSeconds = 20
)
$ErrorActionPreference = 'Stop'
if ($Name -eq 'claude') { $Name = 'Claude' } elseif ($Name -eq 'gemini') { $Name = 'Gemini' }

$runtime = Join-Path $PSScriptRoot 'runtime'
$lockFile = Join-Path $runtime "companion-$Name.lock"
$stopFile = Join-Path $runtime "companion-$Name.stop"

$proc = $null
if (Test-Path -LiteralPath $lockFile) {
    try {
        $lock = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
        $proc = Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue
    } catch { $proc = $null }
}
if (-not $proc -or $proc.ProcessName -ne 'node') {
    Write-Host "托管 $Name 没有在运行"
    Remove-Item -LiteralPath $stopFile -ErrorAction SilentlyContinue
    exit 0
}

Write-Host "正在停止托管 $Name（pid $($proc.Id)）…"
New-Item -ItemType File -Path $stopFile -Force | Out-Null
if ($proc.WaitForExit($TimeoutSeconds * 1000)) {
    Write-Host '已停止'
} else {
    Write-Host '驱动器没有按时退出，结束整个进程树' -ForegroundColor Yellow
    taskkill /PID $proc.Id /T /F | Out-Null
    Remove-Item -LiteralPath $stopFile, $lockFile, (Join-Path $runtime "companion-$Name.json") -ErrorAction SilentlyContinue
}
