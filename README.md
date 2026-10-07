# muxue-mcbot-platform

让不同的 Agent（Claude Code、Codex、DeepSeek Harness、原生 API）用同一套工具，在 Minecraft 服务器里控制一个游戏伙伴。

结构是 **本机 Agent → MCP 与任务层 → 服务端 ServerBody**。玩家只开自己的 MC 客户端，Bot 不需要第二个客户端；服务器要装控制模组。

仓库里没有个人记忆、人设原文、本机登录和连接配置、存档、运行日志、第三方皮肤或整合包素材。

## 从这里开始

- [交付计划](docs/delivery_plan.md)：目标、现在有什么、还没解决的、下一步
- [试玩步骤](docs/survival_trial.md)
- [开发与构建](docs/dev.md)
- [ServerBody 协议](docs/server_body_protocol.md)
- [Agent 接入计划](docs/agent_integration_plan.md)
- [部署与架构取舍](docs/architecture_reassessment.md)
- [归档](docs/archive/)：已完成的批次验收、旧计划、架构评审材料

## 现在能做什么

范围：MC 1.21.1 / NeoForge 21.1.217、独立服务器或开了局域网的单人世界（[单人模式](docs/singleplayer_design.md)）、单 Bot、本机 Agent。2026-10-05 首版受限试玩已验收（[验收记录](docs/archive/server_alpha_release_validation.md)）。

- 跟随、等待、跟随时捡指定物品，可以边做边聊天，随时叫停
- 单格挖放、标准容器、走近取物再交还
- 有限采集：原木、矿石、石料，按方块标签认，模组的树、矿、石头也算；整棵树会垫高砍完
- 背包整理、工具选择、自动进食、原版寻路（能跳一格空隙、开关木门）、近距自卫、跟着玩家睡觉
- 合成和烧炼；切石机、酿造台；附魔台、铁砧、砂轮、锻造台、织布机、制图台（先预览、问过玩家再做）
- 记住地点、回家，最远 2000 格分段走
- 种地：收熟的作物、捡掉落、原地补种，可以播种和用骨粉（模组作物按 `#minecraft:crops` 认）；喂动物繁殖
- 手持物品右键方块（`interact-block`）和对空使用（`use-item`），按登记的交互放行，内置的只有原版堆肥桶
- 内容 Mod：内置 Iron Furnaces 普通铁炉；两个示例附属模组：[森罗厨房](mods/mcbot-kaleidoscope-cookery/README.md)（炒锅做菜）、[Sophisticated Backpacks](mods/mcbot-sophisticated-backpacks/README.md)（打开背包、放置的背包当容器、拾取升级记账）。别的 Mod 可以写附属模组或 JSON 声明来适配（[Mod 适配接口](docs/mod_adapters.md)）

Agent：Claude Code、Codex、DeepSeek Harness（dsh，可直接用桌面版自带的；2026-10-06 隔离服真实模型实测通过）。

还没有：主动保护玩家、建筑、模组机器通用适配、原生 API、多版本。详见[交付计划](docs/delivery_plan.md)。

用 `start-server-play.ps1` 启动。五十多个 MCP 工具不代表所有 Mod 或服务器都能用。托管时可以另开一个终端运行 `node scripts/webui.mjs --open`，在本机网页里看 Bot 状态、游戏聊天、AI 回复和工具调用，也能叫停或停止托管（[说明](docs/dev.md#本地-webui)）。

## 目录

- `client-runtime/`：Body、MCP 工具、任务和陪伴状态
- `mods/mcbot-server-control/`：服务端身体：假玩家、控制租约、原生交互、Mod 适配
- `mods/mcbot-kaleidoscope-cookery/`、`mods/mcbot-sophisticated-backpacks/`：示例附属模组
- `scripts/companion.mjs`、`scripts/agents/`：Agent 会话和事件驱动
- `mcp-server/`、`bot-scripts/`：旧 Mineflayer 实现，用来对照迁移，协议测试玩家也用它
- `mods/mcbot-control/`、`mods/mcbot-server-spike/`：保留的实验（ClientBody、早期服务端原型），不是默认路线
- `docs/`：计划和协议；`docs/archive/`：验收记录和历史材料

构建依赖、启动步骤和真实测试的条件见[开发文档](docs/dev.md)。Agent 账号和服务器要自己配置，仓库不提供登录凭据和测试存档。

## 来源

整仓按 [Apache License 2.0](LICENSE) 发布（2026-10-06 定），版权声明见 [NOTICE](NOTICE)。`mcp-server/` 基于 yuniko-software/minecraft-mcp-server 扩展，保留原许可证和 NOTICE。
