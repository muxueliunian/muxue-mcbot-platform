# A 批次：服务端安全控制验收

> 这是原开发环境的历史验证记录。原始日志、账号环境与测试存档未随整理版上传；整理版自己的复验见 [export_validation.md](export_validation.md)。
本文保留 A 交付时的历史范围与计数。后续 B 的生存交互、物品／容器和原生重生已完成，当前状态见 [B 验收](server_control_B_validation.md)及 [交付清单](../delivery_plan.md)。

2026-10-02。已完成独服控制通道、ServerBody／MCP 和 Agent 无关的宿主停止。范围为 MC 1.21.1／NeoForge 21.1.217、单个生存角色、本机控制。B 的挖放／容器、C 的真实 Claude 模型陪玩、D 内容 Mod、E 单机／异机尚未验收。

## 交付

- `mods/mcbot-server-control/`：鉴权本机 HTTP v2、唯一配置身份、独占租约、动作 ID 与控制代次、真实观察／聊天、看向／有限移动／跟随。没有旧 spike 的 OP 测试命令或产品 RCON 调用。
- `client-runtime/src/server-body.ts`：独立 ServerBody；原 ClientBody v1 保留。MCP 只公开 13 个已支持的查询／事件／控制工具，不声明挖放、容器或记忆工具。
- `scripts/server-body-control.mjs` 与 `scripts/companion.mjs`：独立 watch／revoke；模型忙或 MCP journal 不更新时，宿主仍可叫停。撤销后旧 MCP 终止；缓存的只读 watch 等到新明确任务后才重开，旧停止不会重放。
- `start-server-play.ps1`：默认本机 Claude、low，可选 Codex；沿用所选 Agent 配置环境，不迁移账号。PrepareOnly 只生成接线配置。
- 控制协议见 [server_body_protocol.md](../server_body_protocol.md)。角色保持在线与继续接受旧控制是两回事：stop／release／revoke／失心跳都停止控制，不让角色退服。

## 真实验证

各行包含重复前置检查，不相加成独立场景总数。主链没有调用模型，也没有运行 Bot 的 MC 客户端。Mineflayer 只在观察和聊天场景作为测试玩家使用，不是产品依赖。

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 原生 v2 HTTP：身份、互斥、操作去重、停止代次、撤销、失心跳、新接管 | 36 项通过；首次角色自行加载区块，无观察者或强制加载 | `output/serverbody-control-A-fixed.json` |
| 实际 stdio MCP：13 工具、移动／停止／新动作、EOF、host revoke、强杀后的真实 TTL | 50 项通过；强杀后先 LEASE_BUSY，过期后明确接管，角色不重复 | `output/serverbody-runtime-A.json` |
| 实际观察者：移动同步、跟随、墙、危险边缘、重力／摔伤、受击、kick 后接管 | 66 项通过 | `output/serverbody-physics-A.json` |
| 实际玩家聊天 → 独立 watch → revoke → 新消息后新 MCP | 26 项通过；全程无 MCP events JSONL，旧停止不重新撤销新控制 | `output/serverbody-watch-A.json` |
| 死亡保护 | 7 项通过；旧租约失效，死亡存档不能被 claim 直接加血复活，无残留注册 | `output/serverbody-death-A.json` |
| 跨维度 | 6 项通过；旧租约失效，明确接管后观察正确维度与新会话，返回后新动作成功 | `output/serverbody-dimension-A.json` |

前四组在移除临时复活逻辑之前完成；最后构建只改变死亡分支，随后独立验证了存活角色载入、死亡拒绝与清理、跨维度及新的正常动作。没有把未重跑的项目说成最后一次构建的全量重复验证。

复验入口：

```pwsh
node scripts/server-body-control-smoke.mjs --connection-file runtime/serverbody-validation/config/mcbot-server-control/connection.json --output output/serverbody-control-A.json
node scripts/server-body-runtime-smoke.mjs --connection-file runtime/serverbody-validation/config/mcbot-server-control/connection.json --output output/serverbody-runtime-A.json
node scripts/server-body-physics-smoke.mjs --connection-file runtime/serverbody-validation/config/mcbot-server-control/connection.json --server-dir runtime/serverbody-validation --output output/serverbody-physics-A.json --allow-fixture
node scripts/server-body-watch-smoke.mjs --connection-file runtime/serverbody-validation/config/mcbot-server-control/connection.json --output output/serverbody-watch-A.json
```

这些是串行的隔离服测试，需要已启动的服务与合适夹具。物理脚本会改隔离区域，须事先备份；不能对普通存档随意运行。RCON 只用于夹具、独立状态核对和测试故障注入，移动与跟随走实际产品接口。

## 离线与旧路径回归

- 服务端模块 Java 21 构建、45 项离线检查通过，含租约／操作去重、超时排队请求丢弃、HTTP 边界。
- `client-runtime`：31／31，包括原 client 15 项和 server 16 项、实际 stdio 子进程。
- 新宿主集成 6／6，使用真实 companion＋模拟 Claude／Codex 和控制服，覆盖忙时叫停、旧 watch 换代竞态、异常退出和无 RCON。
- 旧 MCP 完整构建回归：306 项，305 通过、0 失败、1 跳过；`output/serverbody-A-legacy-regression.log`。真实窗口截图仍需显式启用，因此跳过。上述子集不再叠加统计。

## 修复与限制

1. **首次生成区块冻结**：新位置尚未加载，实体不 tick；原实现又依赖实体 tick 迁移玩家区块票，形成循环。已在生成后和独立 ServerTick.Pre 确认传送并更新原版玩家票，不额外执行生存／物理 tick。用从未有过 playerdata 的 UUID、无人／无 forceload 实测通过。
2. **时间与异步边界**：claim 重传返回剩余期限而非重置 TTL；第三方聊天事件返回后再次检查控制，过期不广播；旧 watch 的响应不能指向新租约；失败的并行聊天不能停掉另一条合法移动。
3. **死亡恢复不伪装为普通重生**：已去掉原地满血／满饥饿值逻辑。A 会失效旧控制并拒绝载入死亡角色，原版重生流程仍是 B 的待办。跨维度存活角色可显式重新接管，但没有自动跨维度任务。
4. **可玩范围**：有限平地移动，遇墙／液体／危险边缘停止；没有完整寻路、挖放、机器容器、内容 Mod 声明。Claude／Codex 宿主接线有模拟协议验收，尚无新身体上的真实模型陪玩结论。

## 环境收尾

只更改 `runtime/serverbody-validation/` 隔离服；旧 spike jar 移到其 `disabled-mods/`，正式服和主启动器未改。A 前停服备份 `backups/serverbody-control-A-20261002-170723/`：60 文件、18,163,425 字节，逐文件实际字节相等。

死亡测试前另备份空库存测试 NPC 的 playerdata。负向测试完成后，仅在关服状态恢复这一份测试 NPC 文件，实际字节相等；这是恢复实验夹具，不是产品复活功能。未恢复或修改真人资料。

2026-10-02 17:30（Asia/Tokyo）确认无人类测试玩家在线、无强制加载区块后，正常保存并关闭验证服。未启动真实 Agent 模型，未提交／推送。保留全部未提交改动；全程直接比较字节或字段，未计算任何自定义哈希／指纹。
