# 架构评审入口

## 目标与当前结论

目标是多数Mod／服务器可适配、多Agent及原生API、多MC版本。默认Agent运行在玩家本机，也允许未来选择另一台主机；游戏身体放在服主安装的服务端组件中，避免第二套Bot整合包客户端。当前验证范围只有MC1.21.1／NeoForge21.1.217、单Bot、本机控制和独立服务器。

此次评审先只读。请依据代码与证据判断设计，而不是把文档中的计划当作实现。交付“保留、必须修复、局部重构、补充验证”四类结论；每个问题给出文件／调用链、触发条件、影响和最小建议。没有充分证据时标明待验证，不先大规模重写。

## 阅读顺序

1. `delivery_plan.md`：当前完成范围与未交付项。
2. `architecture_reassessment.md`、`agent_integration_plan.md`：身体／Agent／部署边界与长期目标。
3. `server_body_protocol.md`：租约、代次、动作结果、能力门控、原生组件与拾取收据。
4. `server_escort_validation.md`、`server_gather_validation.md`、`server_control_C_validation.md`、`server_content_D_validation.md`：真实验证及失败边界。
5. 按下面四条代码链核对实际实现。

## 优先核对的代码链

| 主题 | 入口 | 要回答的问题 |
| --- | --- | --- |
| Agent与工具生命周期 | `scripts/companion.mjs`、`scripts/agents/`、`client-runtime/src/main.ts` | Agent、MCP、Body的耦合是否会阻碍新增Agent、API或部署方式？退出、重启、忙时叫停是否有单一可靠的控制路径？ |
| 任务与持续模式 | `client-runtime/src/companion-mode.ts`、`gather-tasks.ts`、`tasks.ts`、`server-body.ts`、`lifecycle.ts`、`events.ts` | 写锁、子任务、观察版本和游戏控制代次各自保护什么？停止与旧回执边界能否统一维护？加入建筑是否需要复制状态机？ |
| 原生交互与适配 | `mods/mcbot-server-control/src/main/java/com/mcbot/servercontrol/` | 通用能力和版本／Mod专用逻辑是否分离？`IronFurnaceAdapter`、资源目录和菜单白名单是否有足够扩展边界？ |
| 用户交互与可靠性 | MCP schema、模型摘要、事件唤醒、测试与验收报告 | 首句、首动作、完成分别耗时多少？哪些查询／工具发现可省？长时间混合任务、重复停止、断线、掉落竞争是否有测试缺口？ |

## 证据边界

- 已有受限原型：控制、单格生存交互、容器取物交还、持续跟随／等待／拾取、有限资源采集；Claude／Codex都做过真实短回归。
- 未交付：持续自动挖矿、建筑预设、复杂寻路、运行机器、广泛Mod适配、单机暂停与异机部署、其他新增Agent／原生API、多版本SDK。
- 一个未运转铁炉样本，不等于任意Mod支持。143／387等是不同层级的检查数，不求和成覆盖率。
- 历史报告的`output/`、`backups/`、绝对路径是原机器证据引用，不随仓库分发。`review_evidence/checkpoint.json`仅摘录非敏感字段，不替代完整日志。
- 有未定位的进程退出记录；后续重跑通过，尚不能证明长时间稳定性。需要给出定位与补测建议。
- 旧Mineflayer能力和ClientBody实验保留作比较，不算新ServerBody已经迁移。

## 建议输出

先给总判断，再按优先级列出有证据的问题、可保留设计及未证明的假设。给出接下来三项最小行动与通过标准；区分“继续玩法前必须修”和“可以后置”。若建议引入框架或大重构，说明它解决的具体重复／耦合及迁移成本。

网页端可以评审源码、运行可用的离线测试；真实游戏、账号测试和存档修改须在获授权的本机环境另行进行。继续使用中文；Windows命令使用pwsh；非必要禁止哈希／指纹，普通比较使用字节或字段。
