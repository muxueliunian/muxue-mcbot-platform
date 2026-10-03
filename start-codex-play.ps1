# Codex V0：只准备/运行 Bot，不启动或修改 Minecraft 服务器。
# .\start-codex-play.ps1 -PrepareOnly 生成可检查的独立试玩配置。
# 默认连接已有的本机测试服 25566；停止用 .\stop-companion.ps1 CodexBot。
param(
    [string]$McHost = '127.0.0.1',
    [ValidateRange(1, 65535)][int]$Port = 25566,
    [ValidatePattern('^[A-Za-z0-9_]{1,16}$')][string]$Name = 'CodexBot',
    [string]$Nickname = 'Codex',
    [string]$WorldId = 'mcbot-ysm-test-world',
    [string]$OwnerPlayers = '',
    [string]$Model = '',
    [ValidateSet('', 'low', 'medium', 'high', 'xhigh')][string]$Effort = 'low',
    [switch]$Headless,
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$playDir = Join-Path $PSScriptRoot "runtime/codex-play/$Name"
$configFile = Join-Path $playDir 'mcp.json'
$memoryDir = Join-Path $playDir 'memory'
$dataDir = Join-Path $playDir 'data'
New-Item -ItemType Directory -Path $playDir -Force | Out-Null
$config = @{ mcpServers = @{ minecraft = @{
    command = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    args = @((Join-Path $PSScriptRoot 'mcp-server/dist/main.js'),
        '--host', $McHost, '--port', [string]$Port,
        '--username', $Name, '--nickname', $Nickname,
        '--world-id', $WorldId, '--owner-players', $OwnerPlayers,
        '--data-dir', $dataDir)
} } }
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configFile -Encoding utf8
Write-Host "Codex 试玩配置：$configFile"
Write-Host "目标：${McHost}:$Port；身份：$Name；记忆：$memoryDir"
Write-Host "服务器需已运行，并允许 $Name 进入。停止：.\stop-companion.ps1 $Name"
if ($PrepareOnly) { exit 0 }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'mcp-server/dist/main.js'))) {
    throw '请先在 mcp-server 目录运行 npm run build'
}
$driverArgs = @('scripts/companion.mjs', '--agent', 'codex', '--name', $Name,
    '--nickname', $Nickname, '--mcp-config', $configFile, '--memory-dir', $memoryDir,
    '--mc-host', $McHost, '--mc-port', [string]$Port)
if ($Model) { $driverArgs += @('--model', $Model) }
if ($Effort) { $driverArgs += @('--effort', $Effort) }
if ($Headless) { $driverArgs += '--headless' }
node @driverArgs
exit $LASTEXITCODE
