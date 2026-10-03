# B：服务端生存交互与原生重生验收

> 这是原开发环境的历史验证记录。原始日志、账号环境与测试存档未随整理版上传；整理版自己的复验见 [export_validation.md](export_validation.md)。
2026-10-02。B1–B4 已交付；实际环境为 Minecraft 1.21.1／NeoForge 21.1.217 独立服务器。下一批是 C 的本机 Claude 真实模型陪玩，内容 Mod 样本按 D 单独验收。

## 实际交付

- `SurvivalActions` 经普通玩家包处理入口执行单格挖掘、放置、选槽、丢物及标准容器操作。没有用 RCON、直接设置方块或直接拆分背包替代产品动作。
- 挖掘按原版服务端进度完成，检查实际主手、目标状态、距离、视线；停止／过期发送 ABORT 并清理原版延迟挖掘状态。新动作必须重新明确提交。
- 放置核对支撑格、目标空气、实际方块物品及消耗后的物品组件；观察不能证明预期效果时返回 unknown，不自动重试。
- 容器使用普通 PICKUP 点击；逐次核对窗口、版本、槽位与 carried 的 ID／数量／组件。关闭或叫停时交还 carried 走原版流程。
- 所有可持久序列化组件统一经 NBT codec 输出实际带类型字段，嵌套物品也保留数值类型；long 用十进制字符串，不在 JavaScript 中丢精度。完整字段比较，不计算哈希或指纹。不可序列化的 transient 组件明确拒绝，需后续专门适配。
- `NativeRespawn` 走原版 `PERFORM_RESPAWN → PlayerList.respawn`。构造点 Mixin 仅保留 Bot 的 `BodyPlayer` 类型；床／出生点、死亡掉落／keepInventory 及 NeoForge 重生事件仍由原版处理。普通 claim 不复活死角色。
- 独立 `--respawn-only` 只重生，不取得控制权、不启动 MCP；重生后必须明确重新接管，旧任务与旧租约均失效。
- ServerBody 按能力发布 **21 个 MCP 工具（11 个动作＋10 个观察／控制工具）**，Claude／Codex 接线同步。ClientBody v1 参数兼容，仍为可选路线。

接口及具体字段见 [协议 v2](server_body_protocol.md)，启动和菜单支持列表见 [服务端模块说明](../mods/mcbot-server-control/README.md)。

## 真实服务器结果

下表各组包含重复前置检查，不相加冒充独立场景数量。`*-typed.json` 使用最终全组件 typed-NBT 构建；此前失败及增量结果也保留在 output 中。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| Node ServerBody → 真实 HTTP → 原生交互 | 98 项通过 | `output/serverbody-survival-B-typed.json` |
| 实际 stdio MCP 工具与事件、退出释放 | 28 项通过 | `output/serverbody-survival-mcp-B-typed.json` |
| 实际非强制床、keepInventory 两种规则、缺床回世界出生点 | 55 项通过 | `output/serverbody-respawn-B4-typed.json` |
| 死亡后 kick，再经实际 CLI 重生 | 24 项通过 | `output/serverbody-dead-kick-B-typed.json` |
| 实际玩家聊天 → 独立 watch／revoke → 明确新任务 | 26 项通过 | `output/serverbody-watch-B-typed.json` |
| 重启后 null 会话直接通过真实 CLI 重生，不先 claim | 21 项通过 | `output/serverbody-dead-save-direct-B-typed.json` |
| 普通启动、关闭测试专用开关后的实际 MCP 生存闭环 | 28 项通过 | `output/serverbody-survival-mcp-B-default.json` |
| 普通启动无测试命令／钩子、规则与角色状态 | 7 项通过 | `output/serverbody-B-default-mode.json` |
| 重启后先 claim 死存档被拒，再显式 CLI 重生 | 23 项通过 | `output/serverbody-dead-save-verify-B.json` |
| 外部授予 OP 时失效旧控制，拒绝接管，撤销 OP 后明确恢复 | 7 项通过 | `output/serverbody-op-guard-B.json` |

死存档的准备／验证由 `server-body-dead-save-smoke.mjs` 分阶段执行，中间真实保存关服、重启。除先 claim 被拒的路径，还验证首次 hello 的 sessionId 为 null 时直接运行重生 CLI。最后两行在全组件统一序列化之前完成；后续字段修改不改变这些生命周期逻辑，最终构建的直接重生结果另记录在 `output/serverbody-dead-save-direct-B-typed.json`。

生存矩阵覆盖：实际工具耐久、方块掉落、走近捡取、放置消耗、指定数量丢物、同动作 ID 不重复丢物、旧窗口／旧版本／错组件拒绝、关闭时 carried 回收。原版出生保护与 NeoForge Break／EntityPlace／RightClick 三类取消事件均用同一方块夹具做正反对照；拒绝后独立核对世界与物品未误改。NBT byte／int 及超出 JavaScript 精确整数范围的 long 差异，都在真实箱子中验证。

## 离线回归

- Java 21 `build`：**80 项**，控制生命周期 52、HTTP 边界 14、精确 NBT 14。异常注入证明原生停止清理抛异常时仍会废弃旧操作和租约；嵌套组件保持精确类型与长整数。
- `client-runtime` build＋tests：**41／41**，含原 ClientBody 15、ServerBody／失效边界 18、B 接线 8。停止回执未确认时终止旧控制，不把迟到的 running 回执误记为已取消后继续发动作。
- 旧路径完整 build＋tests：**306 项，305 通过、0 失败、1 跳过**；日志 `output/serverbody-B-legacy-regression.log`。跳过项是需显式启用的真实窗口截图。宿主／Codex 定向 11 项另有重叠，不再相加。

## 环境与失败记录

仅操作已有授权的 `runtime/serverbody-validation`：游戏 25568、RCON 25578、控制口 8766，均 loopback；没有开启 Bot 渲染客户端或真实模型，也没有改正式服、启动器实例或人物记忆。

停服后备份到 `backups/serverbody-control-B-20261002-181841/`，世界 **86 个文件、27,484,935 字节**，直接逐字节相同；同时保留原服务配置、ops 和 A jar。准备保护用例时临时增加独立测试管理员与出生保护，Bot 本身始终不使用 OP 做生存动作。OP 拒绝用例短暂授予后立即撤销，只验证控制失效。

测试保护钩子和重生点夹具命令仅在 JVM 显式设置 `-Dmcbot.validationFixture=true` 时注册；普通启动默认关闭。RCON 只设夹具、故意制造死亡／权限变化及独立读取状态，不属于产品依赖。实际停止异常的任意第三方 Mod 尚未逐个测试，已通过可控的离线异常注入核对失效语义。

首轮脚本有三种准备错误，均保留失败证据后修正：`execute … run say` 不给 RCON 返回聊天文本，改为读条件命令的实际成功回执；玩家名单需 trim 后解析且解析失败必须拒绝修改；重生回世界出生点后，应先加载远处夹具区块再放置夹具。这些失败没有被算作产品通过。存档、临时规则与测试结束状态见最终收尾记录。

最终于 **2026-10-02 18:49（Asia/Tokyo）** 保存关闭验证服，25568／25578／8766 均无监听。`server.properties` 与 `ops.json` 再次从本轮备份恢复，直接字节相同；世界出生点仍为原值，keepInventory 恢复 false，无 forceload 残留。最终安装 jar 与构建产物逐字节相同。收尾证据为 `output/serverbody-B-cleanup.json`／`serverbody-B-world-restored.json`。仅保留测试区域的合成夹具与测试 NPC 存档；此前未提交改动全部保留，没有提交或推送。

## 明确未交付

标准菜单代码覆盖箱子、漏斗、发射器／投掷器、潜影盒和原版熔炉菜单；本轮完整物品转移矩阵实测的是箱子，不把其他菜单类型或任意 Mod 机器写成已验收。无 codec 组件、特殊 GUI／自定义 payload 和复杂机器需要适配。

C 的真实 Claude／Codex 模型闭环、D 的内容 Mod、E 的单机暂停／异机部署均未完成。自动进食、复杂寻路、建造脚本、长期记忆和思考档位自动分流不在 B 内。原版重生床／世界出生点已验；重生锚及 hardcore 等特殊规则仍需各自实测，不把调用原版路径等同于所有场景验收。
