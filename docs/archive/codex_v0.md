# Codex V0 试玩

2026-10-02。Codex CLI app-server 托管已实现，首轮真实试玩完成；最新快捷停止和停止后首次交还修复待复验。V0 处于收尾，仍使用现有 Mineflayer 身体，之后按 [交付清单](../delivery_plan.md) 优先推进 ClientBody。

## 启动

需要本机已安装、登录 Codex CLI，以及已运行的兼容 Minecraft 服务器。当前核验版本为 `codex-cli 0.159.2`，默认使用该账号当前配置的模型，思考档位固定为 `low`。第一次先构建和检查配置：

```powershell
Set-Location <repo>\mcp-server
npm run build
Set-Location <repo>
.\start-codex-play.ps1 -PrepareOnly
```

默认目标为本机测试服 `127.0.0.1:25566`，游戏名 `CodexBot`，昵称 `Codex`，陪伴玩家 `PlayerOne`。脚本生成 `runtime/codex-play/CodexBot/mcp.json`，将记忆和登记数据放在该目录下；不启动服务器。它不修改根目录 `.mcp.json`，也不改小克、小双的人设或长期记忆。

测试服已启动、玩家进入后，在项目根目录运行：

```powershell
.\start-codex-play.ps1
# 可指定当前账号支持的模型与思考程度：
.\start-codex-play.ps1 -Model '<模型名>' -Effort low
```

思考档位可用 `-Effort medium` 等显式覆盖；当前驱动器仍在启动时选定档位。Codex 每轮请求都会显式带上该值，不修改账号全局设置。按任务自动分流尚未实现，设计见 `agent_integration_plan.md` 的任务档位一节。

`-McHost`、`-Port`、`-WorldId`、`-OwnerPlayers`、`-Name`、`-Nickname` 可选择其他环境与身份。世界 ID 必须对应实际存档，不能把不同存档共用同一个值。当前是已有离线用户名登录路径，不代表已支持正版认证服务器或客户端必装 Mod。

底层入口仍可直接使用 `start-companion.ps1 codex --mcp-config <文件>`；驱动器 `--name`、`--nickname`、运行目录会同步写入生成的 Minecraft MCP 参数。`--config-dir` 对 Codex 表示 `CODEX_HOME`，用于选择已有登录资料目录；不会复制凭据或修改全局配置。

## 试玩与停止

在安全位置依次尝试：

1. `Codex，你好，报告一下自己的状态。`
2. `Codex，跟着我走一小段。` 玩家移动几格。
3. `Codex，停下。`
4. `Codex，把背包里一件已有的物品给我。` 没有物品时应如实说明。
5. 停掉驱动器后重新启动，确认只有一个 Bot 控制者，状态恢复正确且没有重做旧任务。

**快捷叫停**：`Codex，停下`、`CodexBot stop`，或单独说 `停下`／`停止`／`stop`。驱动器立即通过同一 MCP 连接调用 `stop-action`，同时中断正在运行的模型轮次；等旧轮真正结束后再次收回可能迟到的动作，再由程序在游戏里确认“已停下”。正常叫停保留 Agent、会话和游戏连接，不退出重进，也不需要再花一轮模型推理生成确认。旧队列与工具事件游标一起推进，停止时间记录持久化，后续会话不会把停止前的指令重新执行。

若 10 秒内无法确认取消完成，或停止工具报错，驱动器会明确记录失败并结束托管，避免在失去控制时继续动作；不会冒称停止成功。普通句子里提到“停止”不会自动触发快捷叫停。早期采用的退服式叫停已经替换；程序升级或 Agent 崩溃时身体仍可能重连，完整生命周期解耦留待后续。

停止整个托管：

```powershell
.\stop-companion.ps1 CodexBot
```

日志为 `runtime/companion-CodexBot.log`。Codex 路线的驱动器故障提示写日志，不调用本机正式服的 RCON；正常对话由 Minecraft 的 `send-chat` 工具发送。无人在线时 Bot 可停放，启动轮只确认待命，游戏事件随后唤醒模型。

## 接入范围与证据

- app-server 握手、线程创建／恢复、事件排队、文本输出、工具活动、token 用量、失败、取消和进程恢复已接入。请求结果未知时不会自动重放已交付游戏动作。
- Codex 仅开放聊天、状态／位置／背包／实体查询、移动／跟随／停止、进食、捡取／给予物品和只读记忆工具。调用现有 MCP 工具，不另建绕过游戏动作保护的通道；脚本执行、批量建造和视觉工具尚未开放。
- 每个会话禁用继承的其他 MCP 服务，并使用明确的 Minecraft 工具允许列表；禁用 shell、其他 Agent、插件、Apps、hooks 和 Codex memories，申请 `read-only`、`approvalPolicy: never`。这是 Agent 配置限制，不是对 Minecraft MCP 进程的操作系统沙箱；MCP 仍可执行已开放的游戏动作。
- 本机真实探针验证了 ChatGPT 已登录、线程创建、`readOnly/networkAccess:false`、MCP 工具过滤及假 `get-status` 返回。随后按用户授权备份并启动测试服，首轮真实模型陪玩已完成，具体结果见下文。全局 AGENTS 指令源仍可能被 Codex 加载，不能宣称完全隔离全局指令；内置 `node_repl` 在工具目录中可保留一个无工具的记录。
- 新增离线测试覆盖握手期间排队、恢复、重复与迟到通知、RPC/回合错误、忙轮中断、单实例锁、崩溃后不重放，以及停止期间迟到的 RPC 回应。完整结果见 `delivery_plan.md`。

真实试玩已确认自动进服、聊天、状态查询、跟随调用、恢复会话及物品交还；用户确认收到草方块，也确认停止时没有退出游戏。首次停止复验使用单独“停下”，当时仍经模型处理、约 22 秒才停；已补直接控制识别，最新快速路径延迟待下次试玩测量。交还的首次移动失败已通过真实 pathfinder 离线复现并修复：清空路径后冗余的延迟停止调用会误取消下一次移动。修复后的首次交还仍需游戏复验，不能用模拟进程测试代替。

接口依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)、[权限范围](https://learn.chatgpt.com/docs/permissions)。
