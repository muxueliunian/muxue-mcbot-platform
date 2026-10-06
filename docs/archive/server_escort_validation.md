# ServerBody 跟随拾取首批（2026-10-03）

> 这是原开发环境的历史验证记录。原始日志、账号环境与测试存档未随整理版上传；整理版自己的复验见 [export_validation.md](export_validation.md)。
本批把有限拾取接入持续陪伴。范围是“跟着指定玩家，并顺手捡明确指定物品”，持续挖矿、战斗、开路和建筑仍另行交付。Agent默认本机，服务端身体不用另一套MC客户端；重复调度在程序中执行。

## 交互与控制边界

`companion-mode`保留follow／wait／pause／resume。新的follow可带`pickup:{items:[物品ID],radius}`，明确1–8种物品，半径默认3、范围1.5–4格，跟随距离不得超过拾取半径。未带pickup的普通跟随保持原行为，只有服务端声明`companion-pickup`能力才接受此选项。

靠近玩家并等待时，程序观察已加载、可见、范围内的掉落，短暂停止原生跟随，执行有界拾取后继续同一陪伴意图。一次只处理一个真实UUID，不逐件向Agent发完成通知。普通聊天继续可用；满包、未知结果或危险停止并给一次必要说明。pause保留意图，恢复必须明确指令；wait切换为原地等待并清除拾取配置，stop丢弃整个旧意图，迟到回执不能重启。

陪伴全程持有同一身体任务锁。内部切换使用停止与控制代次屏障；子任务借用锁，不自行释放外层锁。控制会话失效、玩家身份或维度变化不能通过重读状态自动恢复。游戏端`pickup-item`可携`companionGuard:{player,expectedEntityId,maxDistance}`，核验绑定玩家及执行范围，路线与逐步移动遵守边界。

“只捡指定物品”表示程序只主动追逐白名单目标；Minecraft原生碰撞拾取仍可能顺带取得脚边其他物品，不能宣称物理上禁止所有其他拾取。获得量沿用原生事件收据，未知或历史缺口如实保留最后确认量，不依据实体消失或背包净增推断成功。

## 验证环境

只使用已授权的`runtime/serverbody-validation/`，MC1.21.1／NeoForge21.1.217，25568／25578／8766。本批停服备份在`backups/serverbody-escort-20261003-133253/`，139文件、54,206,994字节，直接比较实际字节全部一致，未遍历libraries联接。备份记录（本地证据未随仓库分发：`../output/serverbody-escort-backup.json`）。

真实程序脚本为[`server-escort-smoke.mjs`](../../scripts/server-escort-smoke.mjs)，真实模型脚本为[`server-escort-agent-trial.mjs`](../../scripts/server-escort-agent-trial.mjs)。独立平台位于x/z2400..2444、地面y200。RCON只准备夹具和读取独立事实，产品控制与任务不使用RCON。真实Claude使用用户2026-10-03指定的Claude-b；Codex用现有本机登录，均沿用low，不以模型TPS解释架构问题。

## 验收记录

游戏端Java21构建通过 **387项检查**，其中新增57项覆盖玩家绑定、范围、路径、已收物品后越界及普通拾取兼容。最终jar为158,593字节；构建日志（本地证据未随仓库分发：`../output/server-escort-java.log`）保留首次测试辅助函数名称遮蔽导致的编译错误，修正后完整构建通过。Java源码另经独立只读核查。已按停服备份安装到25568，直接字节相同；安装记录（本地证据未随仓库分发：`../output/serverbody-escort-install.json`）。

宿主现有12项针对测试通过，记录在host回归（本地证据未随仓库分发：`../output/server-escort-host-regression.log`）。启动提示补充持续拾取入口与范围，并明确“资源石头→掉落圆石”的ID区别，减少上批发现的无效发现请求。本批没有修改旧Mineflayer产品动作，未重复跑其全套；此前完整基线为312通过／1跳过。

### Node与真实程序验证

TypeScript构建与 **143／143项测试**通过，含新增17项陪伴拾取检查，见全量日志（本地证据未随仓库分发：`../output/server-escort-runtime-regression.log`）与专用日志（本地证据未随仓库分发：`../output/server-escort-pickup-regression.log`）。最终重新构建的dist与进服版本直接逐文件比较实际字节，没有差异，见构建对照（本地证据未随仓库分发：`../output/server-escort-runtime-build-comparison.json`）。

本批处理的边界包括：借用同一写锁的子任务不释放新任务的锁；内部停止换代前后的旧观察不能误判失控；暂停／叫停时迟到回执不重启；自发停止的前后代次需明确核验；选中掉落到子任务初读间的原生拾取按实际收据处理；顺路自然拾取其他UUID由外层统计一次，不能令单件任务误停。收据有缺口时保留最后确认量并停止，不能把未知当作完整成功。

初次独立运行专用suite为16通过／1失败：普通跟随的允许物品夹具残留到了下一项过滤测试，导致程序正确开始拾取，而测试错误地读取已清除的跟随operation。清除该项旧夹具后17／17通过；保留失败日志（本地证据未随仓库分发：`../output/server-escort-pickup-independent.log`），未为测试放宽产品逻辑。

真实stdio MCP程序矩阵 **23／23通过**，证据为`server-escort-2026-10-03T05-07-34.867Z/`（本地证据未随仓库分发：`../output/server-escort-2026-10-03T05-07-34.867Z/`）及`serverbody-escort-latest.json`（本地证据未随仓库分发：`../output/serverbody-escort-latest.json`）：

- 普通跟随不主动追物；显式白名单开启后，先后新出现的3个、2个雪球被实际拾取并累计为5，随后继续跟随真人协议玩家移动。
- 两次成功拾取均不产生task或companion唤醒；聊天、查询可用，有限写任务仍被共享锁拒绝。
- 非白名单与玩家半径外目标不主动追；暂停保留配置、显式恢复、wait清配置、stop不能恢复均通过。
- 满包收住动作且只发一次阻断通知；玩家出半径后停止该次拾取并回跟随；目标离线停止。
- 运动中叫停无迟到追物，第一条新collect任务实收16；平台支撑方块未被破坏。

### 实际Agent：Claude-b与Codex均通过

两个Agent分别完成5个阶段：有限拾取一组16雪球 → 开启跟随并顺手拾两批圆石 → 聊天后继续跟随 → 独立叫停 → 第一条新任务采2块圆石。两个圆石批次为5＋7，实际库存12；之间没有再发模型指令、没有每物品完成唤醒。最后的有限采集均实际挖2／收2，等待游戏完成回复和该回合结束后才关闭宿主。

| 样本 | Claude-b／Sonnet5.5／low | Codex／宿主默认模型／low |
| --- | --- | --- |
| 一组雪球首句 | 4,284ms | 13,259ms |
| 开启跟随拾取首句 | 3,018ms | 7,070ms |
| 普通聊天首句 | 2,334ms | 5,414ms |
| 独立叫停确认 | 163ms | 483ms |
| 新采集任务首句 | 10,322ms | 15,244ms |

这是少量功能样本，不能外推为TPS或模型性能对比；首次工具发现与多次规划／查询仍影响响应，未宣称延迟已全部解决。Codex此次也实际调用了discover-resources／gather-resources／collect-items，补齐上批三项新采集工具的短回归，但不代表全部参数或99组件样本都由Codex再次验证。

证据：Claude最终目录（本地证据未随仓库分发：`../output/escort-agent-claude-2026-10-03T05-08-19.457Z/`）、Claude汇总（本地证据未随仓库分发：`../output/server-escort-claude-latest.json`）、Codex最终目录（本地证据未随仓库分发：`../output/escort-agent-codex-2026-10-03T05-13-46.032Z/`）、Codex汇总（本地证据未随仓库分发：`../output/server-escort-codex-latest.json`）。

### 中断与收尾

先前空载Java进程在开测前已退出，日志没有退出原因；第一次程序尝试仅得到ECONNREFUSED，未操作游戏。原启动日志保留为`output/serverbody-escort-server-attempt1.stdout.log`，失败尝试在`output/server-escort-2026-10-03T05-06-16.586Z/`；重启相同jar后完成上述矩阵。

Codex首次模型测试在有限拾取完成、持续模式受理后，测试进程以1退出，宿主和测试玩家一起消失，没有最终报告。原因未确定；未把该次标为通过。保留`output/escort-agent-codex-2026-10-03T05-10-05.777Z/interrupted.json`，确认原宿主已退出后清理它自己的控制／锁文件和夹具强加载，再完整重跑成功。

最终结束所有本批Agent和测试玩家；RCON确认仅ServerBot在线、生命20、无强制加载区块，随后save-all flush与stop。验证服已保存关闭；收尾记录（本地证据未随仓库分发：`../output/serverbody-escort-cleanup.json`）记录端口、进程、文件与最终jar。配置与固定文件按备份恢复后直接字节相同，ops／whitelist未变；存档保留专用夹具和物品变化，保留158,593字节jar。正式服、主启动器、25567内容Mod环境和核心人设未改，未提交或推送。

下一批仍是持续陪挖：明确可采资源、工具与实际掉落、跟随边界及受阻反馈，不把当前拾取模式称为自动挖矿。之后做小型建筑预设；机器运行、E单机／异机和V2／V3各自保留。

后续交接继续中文、pwsh、保留全部未提交改动；非必要禁止计算或校验任何哈希／指纹，比较实际字节或字段。2026-10-03之后的Claude真实测试需先询问账号，不擅自改用其他已登录目录。
