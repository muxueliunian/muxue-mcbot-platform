# 仅在用户批准独立测试客户端后运行。不会修改启动器主实例或启动 Minecraft 服务器。
# NeoForge 开发客户端使用离线测试身份；不能代替目标服务器要求的真实账号。
param(
    [ValidatePattern('^[A-Za-z0-9_]{1,16}$')][string]$Name = 'ClientBot',
    [ValidatePattern('^[A-Za-z0-9.-]+$')][string]$McHost = '127.0.0.1',
    [ValidateRange(1, 65535)][int]$Port = 25566,
    [string]$JavaHome = 'D:/Java/jdk-21'
)
$ErrorActionPreference = 'Stop'
if (Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue) {
    throw '本机 8765 已有客户端控制通道，请先关闭已有开发客户端，避免重复登录同一身份'
}
if (-not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin/java.exe') -PathType Leaf)) {
    throw '请用 -JavaHome 指定 JDK 21 目录'
}
$previousJavaHome = $env:JAVA_HOME
Push-Location (Join-Path $PSScriptRoot 'mods/mcbot-control')
try {
    $env:JAVA_HOME = $JavaHome
    # 仅初始化独立开发实例，避免首启引导挡住显式 Quick Play，以及失焦后暂停控制 tick。
    $developmentRun = Join-Path $PWD 'run'
    New-Item -ItemType Directory -Path $developmentRun -Force | Out-Null
    $optionsPath = Join-Path $developmentRun 'options.txt'
    $developmentOptions = if (Test-Path -LiteralPath $optionsPath) { @(Get-Content -LiteralPath $optionsPath) } else { @() }
    foreach ($setting in @('onboardAccessibility:false', 'pauseOnLostFocus:false', 'maxFps:60', 'renderDistance:6')) {
        $settingKey = $setting.Split(':', 2)[0]
        $developmentOptions = @($developmentOptions | Where-Object { -not $_.StartsWith("${settingKey}:") }) + $setting
    }
    $developmentOptions | Set-Content -LiteralPath $optionsPath -Encoding utf8NoBOM
    Write-Host "启动独立开发客户端 $Name，连接 ${McHost}:$Port"
    Write-Host "实例目录：$(Join-Path $PWD 'run')；连接文件：run/config/mcbot-control/connection.json"
    & ./gradlew.bat runClient "-PbotUsername=$Name" "-PbotServer=${McHost}:$Port"
    $runExit = $LASTEXITCODE
} finally {
    Pop-Location
    $env:JAVA_HOME = $previousJavaHome
}
exit $runExit
