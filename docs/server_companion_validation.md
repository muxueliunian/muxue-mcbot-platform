# ServerBody 持续陪伴首批验证（2026-10-03）

> 这是原开发环境的历史验证记录。原始日志、账号环境与测试存档未随整理版上传；整理版自己的复验见 [export_validation.md](export_validation.md)。
本批交付持续跟随、原地等待、暂停与显式恢复。Agent 用一次任务调用表达意图，程序持续执行；靠近玩家时等候，玩家再走就跟上，普通聊天不取消跟随。尚未交付陪挖、自动拾取、有限采集、动态“组”数量或建筑预设。

## 实现范围

- 游戏端新增 `FollowCompanion`／`follow-companion`：绑定玩家 UUID、真实实体及维度，使用已加载安全平地路线；同一次操作没有原有限跟随的60秒自然结束。到位要求距离和视线，默认距离2.5格（1.5–6）。
- Agent 主机新增 `CompanionMode`，通过 `companion-mode` 的 follow／wait／pause／resume 及 `get-companion-mode` 使用。跟随和等待持有共同任务写锁；暂停确认停止后释放，有限任务结束不自动恢复。聊天及观察可继续。
- 无路、目标离线／超范围、受伤等进入受阻；不会无限重试或在障碍消失后自行恢复。stop、失租约及宿主退出废弃旧执行，下一条明确任务才能开始。
- 普通 following／waiting 变化不唤醒模型；需要说明的失败发一次通知，主动查询与异步通知按操作标识去重。原有限 follow-player 和 ClientBody 保持兼容；完整 ServerBody MCP 工具数为30。

协议和边界见 [ServerBody v2](server_body_protocol.md)，本批不声称复杂地形、楼梯、开门、跨维度或任意内容 Mod 均可跟随。

游戏聊天中的“停／停下／等等”仍按原宿主叫停处理，会取消意图；“在这里等我”可进入wait，之后“重新跟着我”创建明确的新跟随。工具pause保留意图供显式resume；不要将宿主取消当作可恢复暂停。

## 程序与真实服务器证据

[隔离服脚本](../scripts/server-body-companion-smoke.mjs) 通过实际 stdio MCP 操作身体，测试玩家使用真实 MC 协议走动／发言；RCON 仅准备专用夹具及独立读取坐标和方块。最终 19项检查（本地证据未随仓库分发：`../output/serverbody-companion-latest.json`） 全部通过：

| 场景 | 实际核验 |
| --- | --- |
| 持续跟随 | 同一 operationId 超过65秒，测试玩家再次真实走动后 Bot 继续移动 |
| 靠近等候、再次跟上 | RCON实际坐标验证位移及距离，不只读取工具受理状态 |
| 聊天与互斥 | 跟随期间可聊天／查状态；竞争的原子移动被BUSY拒绝 |
| 暂停／恢复／等待 | 暂停及原地等待时玩家走动、Bot保持原地；明确resume后继续移动 |
| 停止 | 清除意图，resume不能恢复已叫停的模式；之后新follow成功 |
| 墙与无路 | 能绕有限墙体且墙仍完整；横贯平台的墙导致受阻，仅一条通知，移除墙不会自动续走 |
| 玩家离线与重连 | 离线受阻，重连不自动恢复 |
| 宿主独立撤销 | revoke之后不追随，角色在线，旧意图清除 |

## 实际 Agent 聊天

[模型测试脚本](../scripts/server-companion-agent-trial.mjs) 只让测试玩家发真实游戏聊天和走动，实际动作由 Agent 自己调用产品 MCP；夹具不代替模型做任务。Claude 使用用户当天指定的 **b账号、Sonnet5.5、low**；Codex 使用本机现有登录、宿主默认模型、low。两者均通过6个阶段：取3原木交还→持续跟随→跟随时闲聊→原地等待→重新跟随→叫停后首次新任务查询。

| 单次样本 | Claude-b | Codex |
| --- | --- | --- |
| 提出持续跟随到第一句游戏回复 | 3.465秒 | 5.906秒 |
| 跟随时闲聊到游戏回复 | 1.887秒 | 5.466秒 |
| 叫停到宿主记录撤销确认 | 0.412秒 | 0.625秒 |
| 叫停后新查询到游戏回复 | 6.569秒 | 15.976秒 |

证据分别是 Claude完整流程（本地证据未随仓库分发：`../output/server-companion-claude-latest.json`） 和 Codex完整流程（本地证据未随仓库分发：`../output/server-companion-codex-latest.json`）。两者闲聊阶段均只发聊天，之后测试玩家再走动，Bot仍继续跟随；停止后玩家继续走，Bot不再追随。玩家背包经RCON独立确认收到3原木，新任务正确报告 Bot 自己持有5钻石。

最终修复后，Claude-b另完成受阻通知专项（本地证据未随仓库分发：`../output/server-companion-claude-blocked-latest.json`）：模型先启动跟随；程序遇NO_PATH只发一次companion通知，模型在游戏里说明找不到路；移除墙后2.5秒仍不自行移动。测试玩家明确“路已经清好了，请继续刚才的跟随”，模型调用action:resume并实际走到玩家身边，没有自动重试旧任务。

这些是本机单轮样本，不是 TPS 或严格性能对照。Claude首次启动准备约一分钟以上，后续完整阶段另计；该冷启动原因本批未定位。Codex取物前仍先get-status、新查询先get-status再list-inventory，存在可减少的往返，不能据此把所有响应优化标为完成。

## 修复与测试中的问题

- 暂停时迟到的后台观察可能把新意图误判为世界变化；先后复现“暂停前开始读”和“暂停转换中开始读”两个窗口。修复按观察所属epoch筛选、转换中推迟监视读取、停止确认后再次推进Body读取版本；真实外部会话／代次改变仍终止。两种窗口均有先失败后通过的确定性回归。
- 失败终态已被主动查询交付后，原先还会再发陪伴通知；现与任务通知共用交付／通知记录，宿主也按session和operationId排除重复。
- 停止不再等待旧动作HTTP回执结束才能放行新任务；依靠已经确认的身体控制代次和本地epoch丢弃迟到结果。
- 第一次程序测试的在线名单解析未去掉RCON末尾换行，误拒绝夹具准备；没有其他真实玩家进入。已修测试解析。
- 第二次程序测试的测试用心跳采用非原子异步写入，读到短暂空文件后正确触发宿主失效保护；改用产品现有原子心跳写入，再完整复跑19项。失败证据保留在 `output/server-companion-2026-10-03T02-42-48.660Z/` 和 `output/server-companion-2026-10-03T02-44-47.645Z/`，不掩盖失败尝试。

最终离线结果：`client-runtime` **100／100**（含15项新增陪伴／并发／通知回归）；旧路径完整 **313项，312通过、1跳过、0失败**，日志 `output/server-companion-legacy-regression.log`，跳过的是可选真实窗口截图；Java **227项检查**（原163＋新增64）。最后两处读取屏障修复后，实际程序19项再次完整通过，证据目录 `output/server-companion-2026-10-03T02-59-35.068Z/`。真人无需上线，本批模型场景由协议测试玩家发起。

## 环境与收尾

测试仅使用 `runtime/serverbody-validation/`，MC1.21.1／NeoForge21.1.217，端口25568／25578／8766。开服前 备份（本地证据未随仓库分发：`../output/serverbody-companion-backup.json`） 至 `backups/serverbody-companion-20261003-113719/`，121文件、42,362,541字节，逐文件实际字节一致；不遍历libraries联接，不计算哈希或指纹。

安装记录（本地证据未随仓库分发：`../output/serverbody-companion-install.json`） 显示227项Java检查构建的122,140字节jar已装入25568隔离服，复制后实际字节一致。正式服、启动器和25567内容Mod验证服未修改；25567仍保留此前D的111,035字节jar。

全部测试结束后已save-all flush并stop，Java PID35880退出，25568／25578／8766无监听。清理记录（本地证据未随仓库分发：`../output/serverbody-companion-cleanup.json`）核对配置及props／ops／whitelist／eula／JVM参数共10文件与备份实际字节一致，config文件集合一致。比较范围内仅server.properties与自动生成的connection.json发生变化并恢复，ops／whitelist未变；没有OP新增或遗留强加载。关服前ServerBot健康20；其角色、测试平台、空箱子和背包变化已随隔离存档保存，不把配置恢复等同于存档回滚。新jar保留供下轮使用；未提交或推送。

后续交接继续使用中文、Windows PowerShell 7；保留未提交改动；非必要禁止任何哈希／指纹，普通比较使用实际字节／字段。之后每轮Claude测试先询问账号，2026-10-03当天使用已指定的Claude-b。
