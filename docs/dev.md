# 开发与验证

修改前读取根目录 `AGENT.md`。本仓库是独立整理的源码快照，原个人备份仓库、Git历史、玩家记忆、存档和运行凭据未迁入。

## 当前路径

- `client-runtime/`：共享Body契约、ServerBody／ClientBody实现、MCP工具、任务与陪伴状态。
- `mods/mcbot-server-control/`：当前主线，MC1.21.1／NeoForge21.1.217服务端身体与原生交互。
- `scripts/companion.mjs`、`scripts/agents/`：Claude／Codex会话驱动和事件调度。
- `mcp-server/`：保留的Mineflayer实现及宿主回归；真实验证用的协议测试玩家也依赖其依赖包。它不是新ServerBody的产品依赖。
- `mods/mcbot-control/`、`mods/mcbot-server-spike/`：保留的ClientBody与早期服务端实验，不作为默认主线继续扩大。

## 离线验证

Node.js版本要求以两个包的`package.json`为准；当前验收使用Node24，Java模块使用JDK21。首次安装需要访问包源。

```pwsh
Set-Location client-runtime
npm ci
npm test
Set-Location ../mcp-server
npm ci
npm test
Set-Location ../mods/mcbot-server-control
./gradlew.bat build
```

Java检查由`controlTest`接入`check`，标准Gradle `test`任务关闭；应查看实际检查输出，不能仅凭`test SKIPPED`断言没有检查。Linux可用`bash ./gradlew build`，但本次整理版仅在Windows复验；Windows原生窗口截图、进程控制等用例不能直接外推为云端通过。

## 接入游戏

先由服主准备获授权的MC1.21.1／NeoForge21.1.217隔离服务器，备份后安装自行构建的控制Mod；配置见模块README。控制Mod生成的`connection.json`只留本地。

```pwsh
./start-server-play.ps1 -ConnectionFile '<server>/config/mcbot-server-control/connection.json' -Agent claude -PrepareOnly
./start-server-play.ps1 -ConnectionFile '<server>/config/mcbot-server-control/connection.json' -Agent claude
```

当前仅支持loopback。Agent账号由使用者在本机配置；真实模型测试前确认使用的账号，不自动切换或复制凭据。Codex可用同一入口的`-Agent codex`。不要安装spike和正式控制Mod到同一实例。

2026-10-03用户指定Claude-b；该日之后每轮真实Claude测试先问账号，不擅自回退。`-ConfigDir "$env:USERPROFILE/.claude-b"`仅选本机已有登录环境。

启动入口可选`-NodePath '<本机Node可执行文件>'`，同时用于宿主与MCP，不改变全局PATH。本机Node24.15出现过0xC0000409原生退出；本批完整实服／模型／运行端回归使用已存在的独立Node24.19通过。原因尚未定论，不能把新运行时短测通过当作历史退出根因已解决，见[第一批验收](server_survival_alpha_validation.md)。

`scripts/server-*-smoke.mjs`和`*-agent-trial.mjs`是专用隔离服夹具脚本，依赖本地备份记录、端口和存档；干净clone不具备这些条件，不要直接对日常存档运行。RCON只用于夹具和独立核对，ServerBody产品路径不需要它。`MC_SERVER_DIR`可指定RCON所读的本地服务器目录。

## 进度与证据

2026-10-04 [第一轮容器与矿石](r8_ore_offline_validation.md)增加整栈两次点击、容器90秒总期限、操作额度诊断及煤／铁／铜普通产物目录，2026-10-05纳入主线整理提交。用户要求本轮只编码，未开服／连服或安装产物，当前运行中的服务器不因此自动获得新能力；实服和真实模型仍待下一轮验收。服务器仍供用户使用，须待用户明确恢复测试；接续顺序见交付计划顶部。

2026-10-03 网页评审后的 R1／R2／R3 修复见[边界修复记录](boundary_review_fixes.md)。ServerBody Claude 游戏模式现移除全部内置宿主工具，仅使用 Minecraft MCP；人设由宿主固定只读注入，不依赖 Agent 的 Read／Write。要求支持 `--restricted` 的 Claude CLI（本机核对 2.1.287，最低 2.1.248）；参数不支持时不能降级宽权限。

后续[混合故障回归](server_mixed_validation.md)已完成并补齐R4的共享写锁和停止确认边界：运行端157项、实服基线24项、3轮108项、约5分钟10轮349项及Claude-b真实10阶段通过；新验证副本已保存关闭。新脚本`server-mixed-smoke.mjs`、`server-mixed-agent-trial.mjs`仍要求获授权隔离服及本批备份，不对普通存档运行。

[基础生存Alpha](survival_alpha_plan.md)第一批背包／工具／进食已完成。第二批有限高差导航、自卫／退让、威胁与AI策略已通过227项运行端、732项Java、55项真实程序及Claude-b五阶段；已完成30分钟受控运行及独立短复验（生命值检查缺口见记录），见[第二批记录](server_navigation_defense_validation.md)。所有本能共用写权，未知不自动重试；策略修改先停止旧活动任务。当前完整39工具；根规则中的33是较早快照数量，实际以capabilities和最新记录为准。复杂Mod、持续陪挖／完整建筑及新增Agent/API随后。R6仅完成自身库存退化；R5／R7、R6剩余部分、多小时稳定性、真实Mod异常和Node24.15原生退出仍待做，R8已编码并通过离线检查、实服待验。文字“暂停”当前走宿主硬停止，Agent软暂停另有实际模式状态。

进度见`delivery_plan.md`；架构评审从`review_guide.md`开始。整理前最近一次为143项Node检查、387项Java检查、23项真实程序检查，Claude和Codex各5个实际阶段。真实报告是历史执行记录，原始日志／存档仍留本地，不代表网页评审者已复现。整理版自己的离线复验另见`export_validation.md`。
