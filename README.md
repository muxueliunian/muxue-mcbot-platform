# muxue-mcbot-platform

MCBOT的独立整理版：让不同Agent通过统一工具与任务接口，在Minecraft服务器中控制一个游戏伙伴。

当前主线是 **本机Agent → MCP与任务层 → 服务端ServerBody**。玩家只运行自己的MC客户端；Bot不需要第二套整合包客户端。服务端需安装控制组件。

本仓库用于继续开发和架构评审，采用独立Git历史。未包含个人记忆、人设原文、本机登录／连接配置、存档、运行日志、第三方皮肤或整合包素材。

## 从这里开始

- **网页端评审：[架构评审入口](docs/review_guide.md)**
- [交付计划](docs/delivery_plan.md)
- [开发与构建](docs/dev.md)
- [部署与架构取舍](docs/architecture_reassessment.md)
- [ServerBody协议](docs/server_body_protocol.md)
- [整理版复验](docs/export_validation.md)

## 当前范围

| 能力 | 状态 |
| --- | --- |
| 服务端角色、独占控制、独立叫停、原生重生 | 受限独立服务器上已验证 |
| 单格挖放、标准容器、走近取物并交还 | 已验证，有距离／地形／源栈限制 |
| Claude／Codex陪玩 | 真实聊天与任务短回归通过 |
| 持续跟随／等待／暂停／指定物品拾取 | 已验证，程序执行重复动作，聊天并行 |
| 有限采集、Agent自主选择数量、实际堆叠上限 | 首批已验证，资源仅部分石料与原木 |
| 内容Mod | 仅Iron Furnaces普通未运转铁炉的有限样本 |
| 自动陪挖、建筑、运行机器、单机／异机、更多Agent/API、多版本 | 尚未交付 |

当前仅声明MC1.21.1／NeoForge21.1.217、单Bot、本机loopback控制。33个MCP工具不代表所有参数、Mod或服务器均已支持。最新真实证据见[跟随拾取](docs/server_escort_validation.md)与[有限采集](docs/server_gather_validation.md)。

## 目录

- `client-runtime/`：当前Body／MCP／任务运行端，名称保留以便核对既有代码。
- `mods/mcbot-server-control/`：服务端原生角色、控制租约、交互与有限Mod适配。
- `scripts/companion.mjs`、`scripts/agents/`：Agent会话与事件驱动。
- `mcp-server/`、`bot-scripts/`：旧Mineflayer实现与回归，供迁移对照及协议测试玩家使用。
- `mods/mcbot-control/`、`mods/mcbot-server-spike/`：保留实验，非默认玩法路线。
- `docs/`：计划、协议、验收与评审材料。

构建依赖、启动步骤与真实测试条件见[开发文档](docs/dev.md)。使用自行配置的Agent账号和服务器；仓库不提供登录凭据或可直接运行的测试存档。

## 来源

`mcp-server/`基于yuniko-software/minecraft-mcp-server扩展，原Apache-2.0许可证和NOTICE保留。其他模块与Gradle wrapper的既有许可证声明保留；本次整理没有重新指定整仓统一许可证。
