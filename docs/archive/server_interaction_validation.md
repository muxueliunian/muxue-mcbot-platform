# ServerBody 交互修复验证（2026-10-02）

> 这是原开发环境的历史验证记录。原始日志、账号环境与测试存档未随整理版上传；整理版自己的复验见 [export_validation.md](export_validation.md)。
本轮交付了真实库存归属、附近容器发现及共享任务入口，并在已有授权的 `runtime/serverbody-validation/` 隔离服验证。没有调用模型，测试玩家为真实 Minecraft 协议客户端 `TestPlayer`；RCON 仅用于备份后准备专用夹具、独立读取权威结果和收尾。

## 证据与结论

- 真实 MCP 检查结果（本地证据未随仓库分发：`../output/serverbody-interaction.json`）：**29／29 通过**。脚本为 [server-body-interaction-smoke.mjs](../../scripts/server-body-interaction-smoke.mjs)，需显式 `--allow-fixture`。
- 测试玩家事件（本地证据未随仓库分发：`../output/serverbody-interaction-peer.jsonl`）：记录发言、拾取及实际背包。服务器独立 `data get entity TestPlayer Inventory` 同样确认3个原木，不能仅以掉落实体消失判定交还。
- Java 21 `D:/Java/jdk-21` 下 `mods/mcbot-server-control/.\gradlew.bat build` 通过，离线检查104项。本页不将不同矩阵相加。
- 最终 `client-runtime` 构建＋测试 **62／62**，日志 `output/server-interaction-runtime-regression.log`；包括摘要不改原组件、来源隔离、终态两种到达顺序去重、任务取消／窗口变化／部分丢物／超时停止及实际 MCP 接线。
- 旧路径最终完整构建＋回归 **311项，310通过、0失败、1跳过**，日志 `output/server-interaction-legacy-regression.log`；跳过为需显式启用的真实窗口截图。包含 Claude／Codex 模拟驱动取消收尾新消息一次投递、旧Client工具兼容、Codex26工具清单、残留文件按身份及字节清理。`git diff --check` 通过，仅有现有换行格式提示。

| 场景 | 权威结果 |
| --- | --- |
| 两个箱子，有墙遮挡其一 | 返回可见／遮挡候选；明确玩家中心与 Bot 中心不同；最大1个候选时标记截断 |
| 未打开箱子发现 | 返回方块身份／属性／位置／距离和预算，不返回物品内容 |
| 箱内8原木、自身5钻石 | 原木为 `source:container`；钻石为 `source:player, playerSlot:8`；容器摘要不包含自身钻石 |
| 实际菜单库存映射 | 箱、桶、漏斗、投掷器、发射器、白色潜影盒、熔炉、烟熏炉、高炉均具有正确真实库存来源；原生玩家索引0–35完整 |
| 发现后提交取3原木交还 | 程序完成开箱、取物、关箱、转向、选槽和丢物；箱剩5、Bot钻石仍5、菜单及 carried 收尾为空 |
| 同ID原木不同 custom_name 组件 | 返回 `AMBIGUOUS_ITEM`，已取出数量0，实际箱内字段完全不变，关闭任务拥有的菜单 |
| 快捷栏没有空位 | 拒绝转移，来源数量完全不变；首版要求空快捷栏槽，不等价于任意背包位置自动整理 |
| 叫停后旧引用及新请求 | 旧容器引用失效且不开箱；重新发现后的首个任务成功，无旧停止状态残留 |

完整 typed-NBT、实际菜单版本和栈快照仍在运行端核验；给模型的容器引用为随机短期索引，不是哈希／指纹。槽位先按 `Slot.container == player.getInventory()` 判断玩家归属，其他已支持菜单以真实容器身份及版本固定的原生槽位契约校验，未知归属拒绝任务，不推断末尾36格。

附近发现 `radius` 为1–8，`maxResults` 为1–16，水平圆范围及 y±2，检查上界1445格、方块读取预算8192；扫描和遮挡的形状邻居查询都使用 `getChunkNow` 已加载区块访问，不请求生成区块，不读取 BlockEntity。运行结果包含预算和遮挡标注；本次没有刻意构造未加载穿越射线，相关防生成约束通过源码检查和已加载夹具实测，不能称作所有未知遮挡分支的游戏验收。

## 此次调用与耗时

最新固定近距样本（箱子和接收者均已在触及范围）：

| 指标 | 实测 |
| --- | --- |
| 模型侧工具调用 | 2次：`discover-containers`、`fetch-and-give`；测试没有模型往返 |
| 发现工具 | 4.01毫秒 |
| 任务提交到权威丢出结果 | 162.45毫秒 |
| 发现开始到权威丢出结果 | 166.54毫秒 |
| 测试提供的先行回应到达玩家 | 发现开始后约20毫秒，早于权威丢出结果 |
| 指定玩家实际背包确认 | 发现开始后约2666毫秒，包含原版丢物拾取等待及测试读取周期 |
| 同段 HTTP RPC | 36次：21 `observe`、3 `nearby-blocks`（发现和两次接收者视线核验）、11 `act`、1心跳 |
| `act` 明细 | 1发言、1开箱、5槽点击、1关箱、1转向、1选槽、1丢物 |

任务结果准确报告 `withdrawnCount:3, droppedCount:3, heldCount:0, carriedCount:0, pickup:unconfirmed`。实际拾取由测试玩家和服务器独立确认，产品任务本身没有取得归因拾取证据，仍不能向用户声称已收到。本页区分程序丢出完成与玩家拾取，不据单次本机热链路样本声称模型响应速度改善、稳定延迟或真人体验验收通过。

本轮首版仍要求箱子已在触及范围、接收者在2格内，未交付自动走近／绕障。因此“不给坐标发现近处箱并取物交还”在近距场景已证明；任意站位端到端、持物时叫停、其他玩家抢捡、丢失回执、窗口竞争、异机、Iron Furnaces 内容 Mod 及完整真人复验仍待后续。

上面的“待后续”指真实游戏矩阵；持物取消、丢失回执不重试、窗口变化已有本轮离线任务测试。短期引用绑定位置／方块状态与控制上下文，但同坐标同状态容器替换尚不可识别；列表 variant 编号只是展示，不支持指定其编号取物，组件歧义仍拒绝。

本轮还交付默认结果摘要与独立完整终态trace、已交付结果去重、ServerBody明确聊天的120ms短合并／350ms上限、任务say先回应，以及停止收尾消息队列。Claude／Codex模型及思考档位没有改动，也没有启动新的真实模型调用；工具发现往返、实际上下文增量、热／冷会话响应仍需同条件复测。

## 备份和收尾

- 停服备份记录（本地证据未随仓库分发：`../output/serverbody-interaction-backup.json`）：`backups/serverbody-interaction-20261002-232000/`，包含 world、server.properties、ops、whitelist、config和旧测试 Mod。100文件／27,658,959字节，逐文件实际字节一致，未遍历 `libraries` 联接目录；未计算任何哈希或指纹。
- 只替换隔离服的 `mcbot-server-control-0.1.0.jar`，84,300字节，与本次构建产物逐字节一致。正式服、启动器实例未改。
- 收尾记录（本地证据未随仓库分发：`../output/serverbody-interaction-cleanup.json`）：测试玩家和 MCP 已退出、自己的控制文件已移除，已 `save-all flush` 后 `stop`，Java进程退出，25568／25578／8766无监听。专用夹具强加载票已移除，服务器确认 Overworld 无强加载区块；未添加 OP。
- server.properties、ops、whitelist及 config 中合计8个文件均恢复备份实际字节，config 文件集合也直接比较一致。备份 connection.json 是停服旧令牌资料，下一次正常启动会重新生成。
- 新测试 jar **保留在隔离服**；旧 jar 位于上述备份 `mods/`。专用远处平台、两个箱子和测试库存变更随隔离世界保存；需要回到测试前状态时可恢复完整 world 备份。

前两次尝试分别因测试脚本对带结尾换行的 `list` 解析，以及空菜单结果的错误消息格式而结束，证据保留为 `output/serverbody-interaction-attempt1.json`、`attempt2.json`；后一尝试核心取物交还已通过。修复的是验证脚本，最终29项通过记录来自最后一次完整运行。

后续交接继续使用中文、Windows PowerShell 7，保留未提交改动；非必要禁止任何哈希／指纹，普通回归直接比较实际字节或字段。本轮未提交、未推送。
