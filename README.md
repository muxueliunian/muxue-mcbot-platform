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

范围：MC 1.21.1 / NeoForge 21.1.217、独立服务器、单 Bot、本机 Agent。2026-10-05 首版受限试玩已验收（[验收记录](docs/archive/server_alpha_release_validation.md)）。

- 跟随、等待、跟随时捡指定物品，可以边做边聊天，随时叫停
- 单格挖放、标准容器、走近取物再交还
- 有限采集：石料、原木，煤、铁、铜等 6 种矿石
- 背包整理、工具选择、自动进食、有限高差寻路、近距自卫
- 手持物品右键方块（`interact-block`），按登记的交互放行，首批只有原版堆肥桶
- 内容 Mod 只验过 Iron Furnaces 的普通铁炉

还没有：持续陪挖（程序矩阵已通过，待真实模型和用户验收）、建筑、单人模式、DeepSeek Harness 和原生 API、Mod 适配接口、多版本。详见[交付计划](docs/delivery_plan.md)。

用 `start-server-play.ps1` 启动。40 个 MCP 工具不代表所有 Mod 或服务器都能用。

## 目录

- `client-runtime/`：Body、MCP 工具、任务和陪伴状态
- `mods/mcbot-server-control/`：服务端身体：假玩家、控制租约、原生交互、Mod 适配
- `scripts/companion.mjs`、`scripts/agents/`：Agent 会话和事件驱动
- `mcp-server/`、`bot-scripts/`：旧 Mineflayer 实现，用来对照迁移，协议测试玩家也用它
- `mods/mcbot-control/`、`mods/mcbot-server-spike/`：保留的实验（ClientBody、早期服务端原型），不是默认路线
- `docs/`：计划和协议；`docs/archive/`：验收记录和历史材料

构建依赖、启动步骤和真实测试的条件见[开发文档](docs/dev.md)。Agent 账号和服务器要自己配置，仓库不提供登录凭据和测试存档。

## 来源

`mcp-server/` 基于 yuniko-software/minecraft-mcp-server 扩展，保留原 Apache-2.0 许可证和 NOTICE。其他模块和 Gradle wrapper 保留各自已有的许可证声明；整仓的统一许可证还没定。
