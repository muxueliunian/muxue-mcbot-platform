# dsh 真实模型实测（2026-10-06）

DeepSeek Harness（dsh）接入的第一次真实模型实测，在隔离服上进行，没有真人玩家参与。

## 环境

- **服务器**：隔离测试服 `runtime/serverbody-validation`（超平坦、离线模式，端口 25568），开服前备份过。Bot 是 `ServerBot`。
- **dsh**：用户电脑上 DeepSeek Harness 桌面版自带的 dsh，版本 0.2.0-rc.2。通过 `MCBOT_DSH_DESKTOP` 指定，用它的 Electron 加 `ELECTRON_RUN_AS_NODE=1` 来跑。
- **凭据**：用户在桌面版里配好的 Key（`-ConfigDir ~/.dsh`，也就是 `DSH_HOME=~/.dsh`）。脚本和仓库都不读取、也不保存 Key。
- **模型**：桌面版默认的 `deepseek-v4-flash`。驱动器把思考档位设为 low。
- **启动命令**：`./start-server-play.ps1 -Agent dsh -ConfigDir ~/.dsh -Headless`。
- **测试玩家**：mineflayer 的 `C2Tester`，按时间表在聊天里说话、走动。

## 结果

| 场景 | 结果 |
| --- | --- |
| 连通（只发一句 prompt，不挂 MCP） | 回复"好"，`end_turn` 正常结束 |
| 启动轮 | 按要求不调用游戏工具，6 秒结束 |
| 打招呼 | 调用 `get-status` 和 `send-chat`，3 秒内在游戏里回复 |
| 跟随（玩家在 32 格外） | `companion-mode follow` 返回 `PLAYER_NOT_VISIBLE`。模型在聊天里请玩家靠近，没有自己重试 |
| 软叫停（"停下吧，不用跟了"） | 模型调用 `stop-action`，并回复已经停下 |
| 问背包 | 调用 `list-inventory`，如实回答（小麦种子 10、泥土 4） |
| 跟随（玩家被传送到和 Bot 重叠的位置） | 身体报 `BLOCKED`。模型解释原因，请玩家走开几步再喊它，没有自己重试 |
| 硬叫停（"DeepSeek，停下"） | 驱动器撤销身体控制、结束 Agent，等新任务。之后用昵称问背包，开新会话后正常回答 |
| 重启驱动器 | 用 `session/resume` 接上上次的会话 |
| 跟随（玩家在 Bot 旁边 4 格） | 进入跟随，并回复"好，我来跟着你"。玩家往前走了 17 格，Bot 跟到离玩家约 2.4 格的地方 |
| WebUI「叫停」 | 驱动器收到 `.halt` 标记后按叫停流程处理：撤销身体控制、结束旧 Agent，角色保持在线，之后可以用昵称给新任务 |

- 每轮 3～11 秒，上下文 11k～16k。
- 回复都是中文，聊天短而自然。
- 只用了游戏工具：补丁关掉的命令行、文件、联网等工具一次也没出现。

## 已知问题

- 测试玩家被传送到和 Bot 重叠的位置时，跟随会被 `BLOCKED` 拒绝。真人玩家很少会站进 Bot 身体里，这是测试摆位造成的，不改。
- **会写进用户的 `~/.dsh`**：用桌面版配好的 Key 时，会在 `~/.dsh/profiles` 里多一个 `acp` profile，会话也记在 `~/.dsh/sessions`。桌面版自己的 profile 不受影响。
- **桌面版会自动升级**：升级后版本可能不再是 0.2.0-rc.2，补丁里关掉的工具行号也可能变，要重测。
- 这次没有测持续陪挖和长时间试玩，留到第 10 步三家回归时再测。
