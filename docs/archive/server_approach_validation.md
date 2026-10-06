# ServerBody 走近与目标实例核验（2026-10-03）

> 这是原开发环境的历史验证记录。原始日志、账号环境与测试存档未随整理版上传；整理版自己的复验见 [export_validation.md](export_validation.md)。
本轮在已有授权的 `runtime/serverbody-validation/` 隔离服执行。脚本 [server-body-approach-smoke.mjs](../../scripts/server-body-approach-smoke.mjs) 通过实际 stdio MCP 控制 ServerBody，`TestPlayer` 使用真实 Minecraft 协议客户端接收物品；RCON 仅用于专用夹具准备及独立权威读取。本页不把工具脚本当作实际模型聊天证据。

## 备份与边界

停服备份记录（本地证据未随仓库分发：`../output/serverbody-approach-backup.json`） 包含 world、server.properties、ops、whitelist、config 和原隔离服 mods，备份目录为 `backups/serverbody-approach-2026-10-03-2026-10-03T00-59-30-791Z/`。25568／25578／8766 均无监听时复制，103 个文件／31,717,781 字节逐文件直接比较实际字节一致。未遍历 `libraries` junction，未计算任何哈希或指纹。

正式服务器、启动器实例不在修改范围；测试不会添加 OP。每次夹具变更前执行正常 `list` 查询，仅允许 ServerBot／TestPlayer 在线，其他玩家在线立即拒绝变更。既有未提交内容保留，本轮不提交。

## 实际验证矩阵

脚本完整矩阵在实际服务端通过26项检查，证据为 运行结果（本地证据未随仓库分发：`../output/serverbody-approach.json`） 及 测试玩家事件（本地证据未随仓库分发：`../output/serverbody-approach-peer.jsonl`）。最终安装版本以 jar实际字节安装记录（本地证据未随仓库分发：`../output/serverbody-approach-install.json`） 为准：138项Java离线检查构建，103,938字节，安装文件与构建产物逐字节相等；Node构建及76项测试由实现任务执行。

| 场景 | 必须核对的事实 | 当前状态 |
| --- | --- | --- |
| Bot、箱子、接收者不同站位 | 走近箱子、取3、关箱、返回玩家交出；测试玩家背包和服务端独立读取均确认3、来源剩5 | 通过 |
| 平地墙绕行 | 遮挡候选沿安全路线到达；箱内字段不变、墙仍在 | 通过 |
| 单箱同坐标同状态替换 | 旧ref拒绝，未取新箱、未打开菜单 | 通过 |
| 双箱另一半替换 | 旧ref拒绝，未取新双箱、未打开菜单 | 通过 |
| 正常箱内物品数量变化 | 原容器实例仍可读，返回新的实际数量 | 通过 |
| 末影箱能力一致性 | 不返回必然不支持的末影箱候选 | 通过 |
| 横贯墙、液体、断路 | 无安全平地路线时拒绝，不开箱、不取物 | 通过 |
| 未加载容器目标 | 先发现私有token，移开玩家并移除强加载票；实际目标区块已卸载且token仍在120秒有效期，权威明确`STALE_TARGET: Container chunk unloaded`；执行后仍未加载 | 通过 |
| 移动中叫停 | HTTP relay暂停走近回执，stop立即生效；后续不开箱、不丢物；首个新任务成功 | 通过 |
| 取物后叫停 | relay在返程请求发出前暂停；保留已取3物品，不续丢；首个新任务成功 | 通过 |

relay只代理原鉴权通道，记录动作名、阶段和状态，不记录凭据或完整guard；暂停是可控停止竞态测试。脚本收尾关闭MCP及协议测试玩家并释放控制，移除自己的强加载票。按本轮分工暂留隔离服给父任务进行相同模型／effort的真实聊天对照，最终关服及配置恢复由父任务执行。

最终不同站位样本中，任务提交至权威丢出完成为2,180.695毫秒，程序连续完成两段走近与取物交物，其间75次HTTP RPC；没有模型参与。受控移动中stop样本至任务取消回执为6.7803毫秒。这些是单次本机工具链样本，不能当作模型回应速度或稳定性能门槛。目标区块实际卸载后，原token约1,063毫秒时提交，被明确卸载身份校验拒绝，远未触及120秒有效期。

暂留服务器交接（本地证据未随仓库分发：`../output/serverbody-approach-handoff.json`） 记录最终安装文件仍与build实际字节相等，隐藏Java PID34520；MCP／peer释放后普通`list`仅ServerBot在线，Health20，Overworld无强加载区块。最终关服后需由父任务把最新清理记录追加本页，不能把暂留交接当作已经停服。

产品交还结果仍须区分已取出、当前持有、已丢出和指定玩家已拾取。协议玩家和服务端的独立实收证明不等于产品获得通用拾取归因能力。

未加载场景仅原HTTP权威操作核验，其余任务使用实际stdio MCP。该场景证明目标卸载会拒绝且不加载目标；未刻意制造「目标已加载、路线中间区块未加载」，不把它写作覆盖所有未知路线分支。样本仅有界已加载平地，复杂地形、门、跨栈、特殊组件变体选择、特殊Mod菜单和异机仍未在本轮验收。

第一次尝试对未加载结果只判断failed，审查发现实际为airborne拒绝，因现代superflat地面并非y4而导致测试Bot随后摔死；该记录保留为 attempt1（本地证据未随仓库分发：`../output/serverbody-approach-attempt1.json`），不能证明目标卸载核验。第二次因死去角色未显式复活而在claim拒绝，保留 attempt2（本地证据未随仓库分发：`../output/serverbody-approach-attempt2.json`）。通过显式原版respawn恢复隔离角色的记录为 夹具修复（本地证据未随仓库分发：`../output/serverbody-approach-fixture-respawn.json`）；夹具已改为预建远处y200安全落地点并要求具体STALE_TARGET卸载原因。103,860字节中间构建的完整通过记录保留 attempt3（本地证据未随仓库分发：`../output/serverbody-approach-attempt3.json`），最终版本另完整复跑。

后续交接继续使用中文、Windows PowerShell 7；保留未提交改动；非必要禁止任何哈希／指纹，普通文件或结果回归直接比较实际字节／字段。

## 最终收尾

父任务完成[实际Claude对照](server_agent_interaction_trial_2026-10-03.md)后，已执行`save-all flush`及`stop`。隐藏Java PID34520退出，25568／25578／8766无监听；最终清理记录（本地证据未随仓库分发：`../output/serverbody-approach-cleanup.json`）保存配置恢复事实。server.properties、ops、whitelist及config合计8个文件恢复本轮停服备份字节，config文件集合直接比较相等。103,938字节的走近批次jar留在隔离服，与该次build产物逐字节一致；随后D批次继续构建的jar另部署到25567，不将二者说成当前同一文件。原jar留在停服备份mods中，测试世界和夹具随隔离服保存，本轮未添加OP。
