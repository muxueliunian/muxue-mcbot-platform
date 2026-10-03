# V1：连接已经启动并进服的独立 Bot 客户端；本脚本只运行 Agent/MCP。
param(
    [Parameter(Mandatory)][string]$ConnectionFile,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$WorldId,
    [ValidatePattern('^[A-Za-z0-9_]{1,16}$')][string]$Name = 'ClientBot',
    [string]$Nickname = 'Codex',
    [string]$Model = '',
    [ValidateSet('low', 'medium', 'high', 'xhigh')][string]$Effort = 'low',
    [switch]$Headless,
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
# 先按调用者目录解析，再切工作目录；只把文件路径传给运行端，不读取或输出 token。
$connectionPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ConnectionFile)
Set-Location $PSScriptRoot
$playDir = Join-Path $PSScriptRoot "runtime/client-play/$Name"
$configFile = Join-Path $playDir 'mcp.json'
$entry = Join-Path $PSScriptRoot 'client-runtime/dist/main.js'
$memoryDir = Join-Path $playDir 'memory'
if (-not $PrepareOnly) {
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
        throw '请先在 client-runtime 目录运行 npm install 和 npm run build'
    }
    if (-not (Test-Path -LiteralPath $connectionPath -PathType Leaf)) {
        throw '连接文件不存在。请先启动已安装 mcbot_control 的独立 Bot 客户端，再提供其 config/mcbot-control/connection.json'
    }
}
New-Item -ItemType Directory -Path $playDir -Force | Out-Null
$config = @{ mcpServers = @{ minecraft = @{
    command = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    args = @($entry, '--connection-file', $connectionPath,
        '--username', $Name, '--nickname', $Nickname, '--world-id', $WorldId)
} } }
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configFile -Encoding utf8
Write-Host "ClientBody 配置：$configFile"
Write-Host "客户端身份：$Name；世界资料：$WorldId；思考：$Effort"
Write-Host "请使用独立 Bot 客户端进入目标世界。停止托管：.\stop-companion.ps1 $Name（客户端保持在线）"
if ($PrepareOnly) { exit 0 }
$driverArgs = @('scripts/companion.mjs', '--agent', 'codex', '--body', 'client',
    '--name', $Name, '--nickname', $Nickname, '--mcp-config', $configFile,
    '--memory-dir', $memoryDir, '--effort', $Effort)
if ($Model) { $driverArgs += @('--model', $Model) }
if ($Headless) { $driverArgs += '--headless' }
node @driverArgs
exit $LASTEXITCODE
