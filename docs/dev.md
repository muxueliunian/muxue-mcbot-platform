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

`scripts/server-*-smoke.mjs`和`*-agent-trial.mjs`是专用隔离服夹具脚本，依赖本地备份记录、端口和存档；干净clone不具备这些条件，不要直接对日常存档运行。RCON只用于夹具和独立核对，ServerBody产品路径不需要它。`MC_SERVER_DIR`可指定RCON所读的本地服务器目录。

## 进度与证据

2026-10-03 网页评审后的 R1／R2／R3 修复见[边界修复记录](boundary_review_fixes.md)。ServerBody Claude 游戏模式现移除全部内置宿主工具，仅使用 Minecraft MCP；人设由宿主固定只读注入，不依赖 Agent 的 Read／Write。要求支持 `--restricted` 的 Claude CLI（本机核对 2.1.287，最低 2.1.248）；参数不支持时不能降级宽权限。

后续[混合故障回归](server_mixed_validation.md)已完成并补齐R4的共享写锁和停止确认边界：运行端157项、实服基线24项、3轮108项、约5分钟10轮349项及Claude-b真实10阶段通过；新验证副本已保存关闭。新脚本`server-mixed-smoke.mjs`、`server-mixed-agent-trial.mjs`仍要求获授权隔离服及本批备份，不对普通存档运行。

下一批优先第二个不同菜单语义的Mod样本，先处理R5/R6相关边界，再安排持续玩法和新增Agent/API。R5–R8、多小时稳定性、真实Mod异常和历史进程退出根因仍是明确待办。区分停止输入确认与物理惯性归零；文字“暂停”当前走宿主硬停止，Agent软暂停另有实际模式状态。

进度见`delivery_plan.md`；架构评审从`review_guide.md`开始。整理前最近一次为143项Node检查、387项Java检查、23项真实程序检查，Claude和Codex各5个实际阶段。真实报告是历史执行记录，原始日志／存档仍留本地，不代表网页评审者已复现。整理版自己的离线复验另见`export_validation.md`。
