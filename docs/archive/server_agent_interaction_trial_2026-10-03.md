# ServerBody 新任务接口真实 Claude 验证（2026-10-03）

> 这是原开发环境的历史验证记录。原始日志、账号环境与测试存档未随整理版上传；整理版自己的复验见 [export_validation.md](export_validation.md)。
10:11–10:13 JST，本机现有 `<selected-claude-config>` 登录，明确指定 `claude-sonnet-5-5`／low；实际 Claude 会话记录的模型字段也为此值。使用产品 `scripts/companion.mjs` 和 minecraft MCP，协议测试玩家 TestPlayer 发真实聊天；没有第二套 Bot MC 客户端。独立脚本只准备夹具、发玩家聊天和核对结果，不替模型调用游戏动作。

证据：报告（本地证据未随仓库分发：`../output/serverbody-agent-approach-latest.json`），完整驱动／玩家日志位于 `output/server-agent-approach-2026-10-03T01-11-52.806Z/`。可重复脚本为 [`server-body-agent-trial.mjs`](../../scripts/server-body-agent-trial.mjs)，必须显式 `--allow-real-agent`，先备份隔离服。

| 请求 | 首次游戏回应 | 玩家背包实收 | 实际模型工具 |
| --- | --- | --- | --- |
| 近距箱子取3原木交还 | 6060ms，先说“我去旁边那个箱子里拿” | 8527ms，实收3，RCON独立确认 | 首次ToolSearch，discover-containers，fetch-and-give，send-chat |
| 隔墙箱子取3，再返回玩家 | 6124ms，先说“再拿三个给你” | 11233ms，实收3，RCON独立确认 | discover-containers，fetch-and-give，send-chat |
| 走近过程中说停 | 宿主撤销日志430ms内确认 | 箱内6个未被取走；旧任务没有继续 | 不等待模型，独立watch/revoke |
| 叫停后问背包钻石数量 | 新消息到回复约5131ms | 正确回答5钻石，未继续拿原木 | 新会话ToolSearch、stop-action、list-inventory、send-chat |

取物中间没有让模型逐槽点击、抄写NBT、手工挑选路线点；第一次任务初用工具有一次ToolSearch，第二次直接复用工具。任务返回已丢出和拾取未确认，模型没有把它当作玩家已收到，而是让玩家确认；测试玩家和RCON各自提供真实实收证据。

启动上下文约36k，两项取物任务后约40k，没有本次任务完成事件重复唤醒；这是单次短会话样本，不据此预测长期上下文上限。原始日志发现启动和叫停重启时仍各有一次仅处理spawn的空闲轮；之后宿主已把ServerBody的spawn保留为下一条聊天的上下文、不独立唤醒，模拟Driver回归验证此修复。上述实测时间来自修复spawn空轮之前，不能把之后的静态修复再算作已测加速。

这次与10月2日后半段真人体验使用同一Sonnet模型／low。但位置、任务夹具、会话热度和测试玩家不同，原先“22秒无中途回应”的报告不能直接作为严格前后性能基准。当前证据证明：模型确实使用新任务接口、先回应、自动走近和绕墙返回、独立停止以及新任务成功；多轮统计、首次物理动作的精确时间、工具发现优化和完整真人体验还应继续单列。

Claude收到停止后仍需等待5秒并强制结束旧进程，这是目前可靠的停止兜底；身体控制已经提前撤销。未换模型／思考档位，不以TPS解释交互问题，未复制凭据或修改核心人设。

测试脚本正常停止托管及peer、移除1024区域临时强加载。整个25568隔离服随后保存关闭，配置按备份实际字节恢复；统一备份、产物、游戏矩阵和收尾见[走近验证](server_approach_validation.md)。保留世界测试夹具及所有未提交改动。非必要不计算任何哈希或指纹，继续直接比较字段或字节。
