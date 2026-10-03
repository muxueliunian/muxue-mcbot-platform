# 托管模式启动：让小双 / 小克常驻在线，游戏事件自动唤醒
# 用法：
#   .\start-companion.ps1              # 小双（agy）
#   .\start-companion.ps1 claude       # 小克（Claude Code）
#   .\start-companion.ps1 codex       # CodexBot，独立试玩建议用 start-codex-play.ps1
#   .\start-companion.ps1 gemini --effort low
# 这个脚本在当前窗口里跑（能看到输出、能打字转给 agent）。
# 只开游戏、不要终端窗口的免 CLI 托管用 .\start-play.ps1，停止用 .\stop-companion.ps1。
param(
    [ValidateSet('gemini', 'claude', 'codex')]
    [string]$Agent = 'gemini',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)
Set-Location $PSScriptRoot
node scripts/companion.mjs --agent $Agent @Rest
