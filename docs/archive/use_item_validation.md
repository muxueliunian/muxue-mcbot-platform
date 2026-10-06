# 手持物品使用：验收记录（2026-10-06）

对应 [设计](../use_item_design.md)、[交付计划](../delivery_plan.md) 第 1 步。

## 结论

`use-item-on-block` 和 MCP 工具 `interact-block` 在隔离服上用原版堆肥桶实测通过，两轮各 18 项。`use-item`（对空使用）没有登记的交互，所以服务端不声明这个能力，只有离线测试；要等第 8 步装上 Sophisticated Backpacks 再实测。

## 离线

| 层 | 结果 |
| --- | --- |
| Java（`controlTest`） | 全部通过；新增 `ItemInteractionsTest` 31 项：判定（无变化、正常、概率没涨、最后一个、跳两级、只变状态不消耗、多消耗、多出物品、方块被换、多开菜单、多出掉落物、组件变化、允许的耐久损耗和产物、允许的菜单）、手持规则（空手不是回退）、登记和能力声明（Mod 不在或加载出错就不登记） |
| 运行端（`client-runtime`） | 287 项全部通过；新增 `interact-block.test.mjs` 6 项：按能力和登记 ID 发布工具、没有登记就不声明能力、守卫从观察里填、不在快捷栏／没有物品／手持参数二义时不发动作、本地拒绝未登记 ID 和错误守卫、空手请求不带槽位 |
| 宿主（`mcp-server`） | 642 项：640 通过、1 跳过（原本就跳过）。唯一的失败是写死的 Codex 工具数 39，改成 40 并加了 `interact-block` 的检查 |

## 实服（隔离服 25568，`-Dmcbot.validationFixture=true`）

开始前停服备份了 world、server.properties、ops、whitelist、控制模组配置和旧 jar（`backups/serverbody-use-item-20261006-142728`，逐字节核对）。脚本：`MC_SERVER_DIR=<隔离服> node scripts/server-use-item-smoke.mjs --allow-fixture`，走真实 stdio MCP，不用模型、不用测试玩家。

| 项 | run1 | run2 |
| --- | --- | --- |
| hello 声明 `use-item-on-block` 和 `minecraft:composter/add`，不声明 `use-item` | 通过 | 通过 |
| 真实 MCP 发布 `interact-block`，不发布原子动作 | 通过 | 通过 |
| 连续 10 次放入小麦种子：每次 succeeded、种子正好少 1、level 不变或 +1 | 通过（level 0→1→…→2，其中 7 次是"消耗了但没涨"） | 通过 |
| 泥土（不可堆肥）：UNSUPPORTED，泥土和堆肥桶不变 | 通过 | 通过 |
| 对箱子使用堆肥桶交互：UNSUPPORTED，箱子没打开，种子不变 | 通过 | 通过 |
| level=7 的堆肥桶：INTERACTION_NOT_READY，种子不变 | 通过 | 通过 |
| 10 格外的堆肥桶：OUT_OF_REACH／NO_LINE_OF_SIGHT，种子不变 | 通过 | 通过 |
| 保护夹具取消右键：failed（NO_EFFECT），夹具计数 +1，种子和堆肥桶不变 | 通过 | 通过 |

run1 发现一个问题：NO_EFFECT 的回执带了 inventory，运行端的摘要视图会因此显示 `inventoryChanged: true`，对模型有误导。改成只有 unknown 才带 inventory，重新构建安装后跑 run2，问题消失。成功回执约 540 字节。

收尾：两轮服务器都正常关闭（exit 0）；server.properties 只有启动时间注释变了，已按备份字节恢复；ops、whitelist、控制模组配置和备份一致；forceload 已移除；新 jar（260,197 字节）留在隔离服；夹具区（x6396–6412 z6396–6406、x510–520 z508–516）的方块改动保留。

## 没有测的

- `use-item` 实服：没有物品类交互，第 8 步配合 SB 背包再测。
- 发包前一瞬间叫停的竞态：沿用现有 `NativeActionBoundary` 的离线覆盖，本轮没有实服构造。
- 真实模型调用 `interact-block`：本轮没跑 Claude／Codex。
- `targetToken`：首批不支持，传了直接拒绝。
