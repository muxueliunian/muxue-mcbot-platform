# A：接入已启动的 ServerBody 控制口；Agent 默认在本机现有登录环境运行。
param(
    [Parameter(Mandatory)][string]$ConnectionFile,
    [ValidateSet('claude', 'codex')][string]$Agent = 'claude',
    [string]$Nickname = '',
    [string]$ConfigDir = '',
    [string]$Model = '',
    [string]$NodePath = '',
    [ValidateSet('low', 'medium', 'high', 'xhigh')][string]$Effort = 'low',
    [switch]$Headless,
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
$connectionPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ConnectionFile)
if (-not (Test-Path -LiteralPath $connectionPath -PathType Leaf)) { throw '请提供服务端生成的 config/mcbot-server-control/connection.json' }
$connection = Get-Content -Raw -LiteralPath $connectionPath | ConvertFrom-Json
if ($connection.protocol -ne 2 -or $connection.backend -ne 'server' -or
    $connection.username -notmatch '^[A-Za-z0-9_]{1,16}$' -or [string]::IsNullOrWhiteSpace($connection.worldId) -or
    [string]::IsNullOrWhiteSpace($connection.token)) {
    throw '连接文件必须是协议 2 的 ServerBody，并包含有效的 username/worldId'
}
$endpoint = [Uri]$connection.endpoint
if ($endpoint.Scheme -ne 'http' -or $endpoint.Host -notin @('127.0.0.1', '[::1]', '::1') -or
    $endpoint.AbsolutePath -ne '/v2' -or $endpoint.UserInfo -or $endpoint.Query -or $endpoint.Fragment) {
    throw '当前仅支持本机 http 控制口 /v2；远程部署需后续独立验收'
}
if ($ConfigDir) { $ConfigDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ConfigDir) }
if ($NodePath) {
    $NodePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($NodePath)
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'NodePath 必须指向可用的 Node 可执行文件' }
} else { $NodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source }
Set-Location $PSScriptRoot
$Name = [string]$connection.username
$WorldId = [string]$connection.worldId
if (-not $Nickname) { $Nickname = if ($Agent -eq 'claude') { '小克' } else { 'Codex' } }
$playDir = Join-Path $PSScriptRoot "runtime/server-play/$Name"
$configFile = Join-Path $playDir 'mcp.json'
$entry = Join-Path $PSScriptRoot 'client-runtime/dist/main.js'
if (-not $PrepareOnly -and -not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw '请先在 client-runtime 目录运行 npm install 和 npm run build' }
New-Item -ItemType Directory -Path $playDir -Force | Out-Null
$config = @{ mcpServers = @{ minecraft = @{
    command = $NodePath
    args = @($entry, '--body', 'server', '--connection-file', $connectionPath,
        '--username', $Name, '--nickname', $Nickname, '--world-id', $WorldId)
} } }
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configFile -Encoding utf8
Write-Host "ServerBody 配置：$configFile"
Write-Host "角色：$Name；世界：$WorldId；Agent：$Agent；思考：$Effort"
Write-Host "默认沿用本机现有 Agent 登录。停止托管：.\stop-companion.ps1 $Name（角色保留）"
Write-Host "叫停后，请用角色名或昵称明确提出新任务，例如：$Nickname，查询状态。"
if ($PrepareOnly) { exit 0 }
$driverArgs = @('scripts/companion.mjs', '--agent', $Agent, '--body', 'server', '--name', $Name,
    '--nickname', $Nickname, '--mcp-config', $configFile, '--effort', $Effort)
if ($ConfigDir) { $driverArgs += @('--config-dir', $ConfigDir) }
if ($Model) { $driverArgs += @('--model', $Model) }
if ($Headless) { $driverArgs += '--headless' }
& $NodePath @driverArgs
exit $LASTEXITCODE
