# 架构评审边界修复记录

2026-10-03。对象为独立整理版 `muxue-mcbot-platform`，不修改原个人备份仓库。保留 ServerBody 路线；本轮只修 R1／R2／R3，不增加玩法、不扩大 Mod 白名单，不合并任务 epoch、运行端 revision 和服务端 controlGeneration。

## 评审材料与复现

用户提供了网页评审全文及 [R1 方法级结果](review_evidence/external_r1_method_result.json)。原方法提取脚本无法下载，所以没有声称运行过它。JSON 的三个 `true` 是评审者的结果，`gameWorldMutationTested:false` 明确未测试游戏写入。

本轮在仓库真实 `CompanionMode` 模块、ServerBody HTTP 夹具上重新构造 A → stop → B → A 返回 → C 的交错。修复前 C 被接受，预期应为 `BUSY`；另外验证到旧 `block` 同类问题，以及旧 `internalStop` 收尾把新观察版本从 5 改到 6。它们证明异步状态隔离问题，不证明真实服务器发生重复挖掘。

复验主交错，无需下载原脚本：

```pwsh
Set-Location client-runtime
npm run build
node --test --test-timeout=15000 --test-name-pattern='cancelled initial request' tests/companion-mode.test.mjs
```

修复后此命令应通过；测试使用受控 Promise，不依赖碰运气的时间间隔。

## 本轮修改

| 项目 | 原因与修复 | 确定性证据 |
| --- | --- | --- |
| R1：切换收尾归属 | `changing` 改为独立 Symbol 归属；只有持有者能清理切换并推进观察版本。统一 request、block、internalStop、stop；正常 fail 自增 epoch 不影响自身收尾。空聊天 await 后也重新校验取消 | 七项新增用例覆盖 A/B/C、旧 block、内部停止、stop 延迟、失败恢复及暂停/跟随迟到收尾；陪伴定向 39/39，完整运行端 150/150 |
| R2：写后不确定性 | `SurvivalActions.begin/tick` 共用 `NativeActionBoundary`。调用原生入口前标记待确认，可靠核验后才清除；写后协议异常和运行时异常均保留 unknown。drop finally 保留已确认丢出与移除的独立数量 | 红例观察到点击写后 UNSUPPORTED 被报 failed；新生产边界注入检查 137 项，连同原 Java 387 项共 524 项通过。覆盖点击、放置、挖掘完成异常、确定无变化拒绝、部分丢出、清理抛错、重复 operationId 不重放 |
| R3：Claude 游戏权限 | ServerBody 使用空内置工具集、restricted、dontAsk、无权限提示，关闭技能、hooks和自动记忆；hosted MCP 配置只留 minecraft。宿主固定只读加载 CLAUDE.md 与所选 persona.md，不跟随文内链接；策略版本阻止恢复旧宽权限会话 | 四项新策略检查及真实宿主＋模拟 Agent 的启动、停止、崩溃、新任务回归通过；本机真实 CLI＋模拟 API 的强制宿主工具调用拒绝也通过 |

R2 的注入运行真实生产异常处理类与 ControlSession 回执缓存，但没有实例化 Minecraft 的 SurvivalActions 依赖、没有发实际游戏数据包。源代码调用位置经审查；真实 Mod codec 故障和真实方块写后异常仍需专门验收。运行端既有 unknown 点击回归仍通过：停止后续点击和交物，不重试、不做不安全清理。

R3 仅适用于 `--agent claude --body server`。旧 Mineflayer／ClientBody 权限策略仍保留，不能把它们也说成已经收窄。CLI 仍负责自身认证、会话日志以及启动可信 Minecraft MCP 子进程；本轮禁止的是模型调用通用宿主工具，不是操作系统级隔离。人设只读注入不等于迁移了长期记忆写入。

`--tools ''` 用来移除内置工具，`--allowedTools` 仅控制免确认调用；二者不能混淆。当前本机核对版本为 Claude Code 2.1.287；`--restricted` 需要 2.1.248 或更新版本，旧 CLI 遇到不支持的参数应退出，不降级回宽权限。[官方 CLI 参考](https://code.claude.com/docs/en/cli-reference)

## 验证范围

- `client-runtime npm test`：150 通过；Java `gradlew.bat build --console=plain`：524 项检查通过；`mcp-server npm test`：317 项，316 通过／1 跳过真实窗口截图／0 失败。[从实际日志提取的计数](review_evidence/boundary_checks.json)与历史整理版结果分别保留。
- [Claude 离线权限探针](../scripts/claude-game-permissions-probe.mjs)使用真实 CLI，临时配置目录和假 API Key，全部模型请求指向本机 loopback 模拟接口。最终 **11 条断言通过**，含自身 MCP 退出和临时目录清理；[脱敏执行输出](review_evidence/claude_game_permissions.jsonl)保留。实际 init 与两轮 API schema 只含夹具的 `mcp__minecraft__get-status`；模拟模型强行请求 Write／Edit／Bash／PowerShell 均被拒绝，测试哨兵逐字节未变，正常 MCP 工具执行成功。它证明该版本 CLI 执行了工具限制，不证明真实账号／真实游戏全套 33 工具复验。
- 本轮未启动 Minecraft、未更改或安装服务器 Mod、未改存档、未调用在线 Claude／Codex 账号。
- 本修复批次结束时尚未完成新的真实游戏混合故障回归；后续已完成[混合回归](server_mixed_validation.md)，实际模型、故障注入与未验证边界分别以该记录为准。
- Java `controlTest` 是实际检查入口；不能用标准 `test SKIPPED` 判断没有检查，也不能把三个层级的数量相加当覆盖率。
- 整理前的无原因进程退出尚未定位，后续重跑通过不能替代根因记录。

从仓库根目录运行权限探针：

```pwsh
node scripts/claude-game-permissions-probe.mjs --allow-local-cli
```

该命令不在默认 npm 测试中，避免要求所有构建机器都安装 Claude。`--inspect-legacy` 只检查旧命令暴露的工具清单，不向旧宽权限路径注入写入或执行请求。

## 其余评审项与下一步

| 项目 | 本轮状态 | 进入条件／下一步 |
| --- | --- | --- |
| R4：共享任务锁、stop 完成与旧异步收尾 | 后续[混合批次](server_mixed_validation.md)已修两处确定缺口 | 容器须有完整共享锁；cancel保锁至最新stop确认，旧回执不释放新锁；已补确定性错序和真实首新任务验证，不称统一workflow完成 |
| R5：Mod Adapter 分派与语义能力 | 登记，未修改 | 第二个不同菜单语义的 Mod 前形成薄分派入口；未知 Mod 继续默认拒绝 |
| R6：不可序列化物品导致整体观察失败 | 后续[生存第一批](server_survival_alpha_validation.md)已完成自身库存降级；未全部关闭 | 容器／地面物品仍待扩展；可观察摘要与写入完整前置条件分开，不能把缺失组件当 `{}` |
| R7：Agent 会话入口与公共工具执行入口 | 登记，未修改 | 下一个 Agent／原生 API 样本驱动提取，不复制任务执行策略 |
| R8：逐件取物、总期限、租约操作额度 | 登记，未修改 | 长时间混合回归前评估整栈到已验证空槽优化；保留去重，不无限延长租约操作历史 |

本修复批次提出的顺序为：**边界修复与离线验证 → 现有功能混合故障回归 → 一个扩展样本验证接口 → 再安排持续陪挖／建筑**。后续用户将基础生存列为前置，且两批核心已完成；当前顺序以[交付计划](delivery_plan.md)为准。混合回归覆盖范围和缺口以实际记录为准；计时分别记录首次游戏回应、动作受理、任务完成、停止确认和最后一次实际写入。

扩展样本在“第二个实质不同的 Mod”和“新 Agent／原生 API”中选一个。通过标准是复用任务执行逻辑、保留权威核验，不在通用任务层继续加具体 Mod／Agent 判断。不要同时启动两条扩展线。

后续交接继续使用中文、Windows `pwsh`，保留未提交修改；非必要禁止计算／校验哈希或指纹，普通比较直接核对字节或字段。真实账号与服务器验收按本地授权和备份条件执行。
