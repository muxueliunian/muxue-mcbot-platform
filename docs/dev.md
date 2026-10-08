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

Java检查由`controlTest`接入`check`，标准Gradle `test`任务关闭；`check`还包括`loaderNeutralCheck`：只有`build.gradle`里登记的加载器文件能用`net.neoforged`，其余代码只用原版类，为以后的Fabric版留边界（见[工作站设计](workstation_design.md)）；应查看实际检查输出，不能仅凭`test SKIPPED`断言没有检查。Linux可用`bash ./gradlew build`，但本次整理版仅在Windows复验；Windows原生窗口截图、进程控制等用例不能直接外推为云端通过。

## 接入游戏

先由服主准备获授权的MC1.21.1／NeoForge21.1.217隔离服务器，备份后安装自行构建的控制Mod；配置见模块README。控制Mod生成的`connection.json`只留本地。

日常用法是在 [本地 WebUI](#本地-webui) 的「配置」页保存配置、点「保存并启动托管」（2026-10-08 起用户自己从 WebUI 启动托管）；下面的脚本是同一件事的命令行版本，WebUI 也是调用它。

```pwsh
./start-server-play.ps1 -ConnectionFile '<server>/config/mcbot-server-control/connection.json' -Agent codex -Effort low -PrepareOnly
./start-server-play.ps1 -ConnectionFile '<server>/config/mcbot-server-control/connection.json' -Agent codex -Effort low
./start-server-play.ps1 -ConnectionFile '<server>/config/mcbot-server-control/connection.json' -Agent claude -PrepareOnly
./start-server-play.ps1 -ConnectionFile '<server>/config/mcbot-server-control/connection.json' -Agent claude
```

当前仅支持loopback。Agent账号由使用者在本机配置；真实模型测试前确认使用的账号，不自动切换或复制凭据。Codex可用同一入口的`-Agent codex`。不要安装spike和正式控制Mod到同一实例。

2026-10-03用户指定Claude-b；该日之后每轮真实Claude测试先问账号，不擅自回退。`-ConfigDir "$env:USERPROFILE/.claude-b"`仅选本机已有登录环境。

启动入口可选`-NodePath '<本机Node可执行文件>'`，同时用于宿主与MCP，不改变全局PATH。本机Node24.15出现过0xC0000409原生退出；本批完整实服／模型／运行端回归使用已存在的独立Node24.19通过。原因尚未定论，不能把新运行时短测通过当作历史退出根因已解决，见[第一批验收](archive/server_survival_alpha_validation.md)。

`scripts/server-*-smoke.mjs`和`*-agent-trial.mjs`是专用隔离服夹具脚本，依赖本地备份记录、端口和存档；干净clone不具备这些条件，不要直接对日常存档运行。RCON只用于夹具和独立核对，ServerBody产品路径不需要它。`MC_SERVER_DIR`可指定RCON所读的本地服务器目录。

## dsh（DeepSeek Harness）

dsh 锁定在 `0.2.0-rc.2`，装在仓库的 `runtime/dsh`（被 git 忽略，依赖约 500MB），不全局安装：

```pwsh
cd runtime/dsh
npm install --save-exact @deepseek-ai/dsh@0.2.0-rc.2
```

托管时驱动器用 `dsh --profile acp` 加生成的补丁启动它（只留游戏工具），`DSH_HOME` 默认是 `runtime/dsh/home`，不写用户的 `~/.dsh`。DeepSeek 凭据由使用者用环境变量 `DEEPSEEK_API_KEY` 或 dsh 自己的凭据配置提供，仓库和脚本都不保存。启动：`./start-server-play.ps1 -Agent dsh -ConnectionFile <connection.json>`。别处的 dsh 可用 `MCBOT_DSH_BIN` 指到它的 `lib/bin.js`。

也可以直接用 DeepSeek Harness 桌面版自带的 dsh（默认装在 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，别的位置用 `MCBOT_DSH_DESKTOP` 指到安装目录）：驱动器用它的 Electron 加 `ELECTRON_RUN_AS_NODE=1` 跑 `app.asar` 里的命令行，和它自带的 `dsh.cmd` 一样。找 dsh 的顺序：`MCBOT_DSH_BIN` > `MCBOT_DSH_DESKTOP` > `runtime/dsh` 的锁定安装 > 默认位置的桌面版。想用桌面版里已经配好的 Key，就把 `DSH_HOME` 设成 `~/.dsh`；这会在 `~/.dsh/profiles` 里多一个 `acp` profile，会话也记在 `~/.dsh/sessions`，桌面版自己的 profile 不受影响。桌面版会自动升级，版本和 `0.2.0-rc.2` 不同时要重测补丁。

## 本地 WebUI

```pwsh
node scripts/webui.mjs --open      # 默认端口 8770，--port 换端口，--runtime 指定别的 runtime 目录
```

- 页面风格参考 NapCat WebUI（渐变背景加模糊光斑、透明侧栏、胶囊顶栏和按钮、半透明毛玻璃卡片），颜色、图标、字样都是自己的，没有用它的代码和素材；有亮色、暗色和跟随系统三种主题，窄屏时侧栏变成抽屉。页面在 `scripts/webui-page.html`（单个内联 HTML，不依赖外部资源，改完要重启 WebUI）；下拉框是自己写的组件（原生 select 只当数据存着），按钮、开关、折叠区和列表都有动画，列表按 key 原地更新，不会每次刷新都重画。
- 模型列表从本机 CLI 读（`scripts/agent-models.mjs`），都不发对话消息、不消耗额度：Claude Code 用 stream-json 只发 `initialize` 控制请求（关掉 hooks、不挂 MCP 和工具），返回里有每个模型支持的思考强度；Codex 用 `codex debug models`；dsh 开一个空的 ACP 会话读 `configOptions`（第一次约 20 秒，会在 DSH_HOME 留一条空会话记录）。按 Agent 和账号目录缓存在 `runtime/webui-models.json`，1 小时内不重读，页面上可以「重新读取」。思考强度跟着选中的模型变；读不到列表时 Claude 只给 opus／sonnet／fable／haiku 这几个别名。
- 只监听 `127.0.0.1`。每次启动生成一次性令牌，终端里打印的地址带着它，打开后存进 Cookie；不带令牌、Host 不是本机地址的请求都拒绝，别的网页没法调它。
- 只读驱动器写在 `runtime/` 里的文件：心跳 `companion-<名字>.json`（在线、是否在推理）、会话 `session-<名字>.json`（上下文大小、上次请求）、活动记录 `activity-<名字>.jsonl`（游戏事件和聊天、AI 回复、工具调用、每轮开始和结束、驱动器提示，超过 5MB 轮转）。三家 Agent 都走同一个驱动器，记录格式一样。
- 页面上的「陪伴模式」「最近工具」「最近出错」是从记录里推算的。
- 「叫停」放 `companion-<名字>.halt` 标记，驱动器按游戏里叫停的流程停下动作和推理，等玩家用名字或昵称给新任务（目前只支持 ServerBody）；「停止托管」放 `companion-<名字>.stop`，和 `stop-companion.ps1` 一样让驱动器退出。WebUI 不碰游戏，关掉它不影响托管。
- 「配置」页（`scripts/webui-profiles.mjs`）：按档案保存启动参数，存在 `runtime/webui-profiles.json`，不进仓库。可以配 Agent、账号目录、模型、思考强度、连接文件、昵称、记忆目录、保护玩家（开关、用弓、举盾、范围、撤退血量，见[协议](server_body_protocol.md#保护玩家8h2026-10-08)），高级里有 Node 路径和会话选项；每项对应 `start-server-play.ps1` 的同名参数。「保存并启动托管」用 `pwsh start-server-play.ps1 -Headless` 启动，脚本输出写 `runtime/webui-launch-<角色>.log`，没起来时页面显示退出码和输出。测试用环境变量 `MCBOT_WEBUI_LAUNCH_CMD`（JSON 数组）替换 `pwsh`。
- 配置页只存路径和参数，不存凭据：Agent 用账号目录里已有的登录；档案里出现 `apiKey` 这类不认识的字段会被拒绝。连接文件只读出角色、世界和地址，控制令牌不回传给网页。能从网页启动托管，就等于拿到令牌的人能用你的账号开托管，所以令牌地址不要发给别人。

## 单人模式实测

模组自带开发客户端，游戏目录在 `mods/mcbot-server-control/run/client`（被 git 忽略），不动启动器实例。先在 `run/client/saves/<存档>` 放一份测试世界，`run/client/options.txt` 里写 `pauseOnLostFocus:false`，然后：

```pwsh
./gradlew.bat runClient -PquickPlay=<存档> "-PcommandFixture=<run/client的绝对路径>/mcbot-fixture"
node scripts/singleplayer-smoke.mjs --game-dir '<run/client的绝对路径>' --player Dev --world <存档> [--cheats]
```

`-PcommandFixture` 打开只用于验收的命令文件夹具（内置服务器没有 RCON），独立服务器上不生效。运行时桌面会弹出游戏窗口。

## 进度与证据

**2026-10-05最新约束：用户需要内存，暂不使用服务器。** 已保存关服并停止空闲Java／Gradle进程；在用户明确恢复前，不开服、连服、运行Java构建或真实游戏模型测试。可以继续源码、轻量Node测试和文档。持续陪挖源码／离线检查已完成，完整实服矩阵仍待排查拾取越界并继续；当前测试服已恢复上一轮已验证的Mod，新构建留在build目录，详见交付计划顶部，不能把首个定向通过当作完整陪挖验收。

2026-10-05用户已明确恢复隔离服测试，本轮只使用已有登录的Codex。新组件已安装并完成[首版受限基础搭档验收](archive/server_alpha_release_validation.md)：导航／防卫55项、R8容器24项、矿石14场景53项真实程序检查；Codex受控10阶段（叫停212ms、首新任务一次）及普通世界自然3阶段短跟随通过。四个自然目标点的采样累计位移约23.09格、高度63–64.2522，生命核对20；自然叫停323ms。本轮未新增30分钟运行，也未用Claude验证新增矿石。结束已保存关闭、相关端口无监听，服务器配置按备份实际字节恢复，普通验证世界保留本地；新脚本与文档已于2026-10-06提交。

历史：2026-10-04 [第一轮容器与矿石](archive/r8_ore_offline_validation.md)只编码／离线验证，2026-10-05先纳入主线整理提交，随后才完成上述实服验收。不能用前一日离线记录替代实际游戏证据。

2026-10-03 网页评审后的 R1／R2／R3 修复见[边界修复记录](archive/boundary_review_fixes.md)。ServerBody Claude 游戏模式现移除全部内置宿主工具，仅使用 Minecraft MCP；人设由宿主固定只读注入，不依赖 Agent 的 Read／Write。要求支持 `--restricted` 的 Claude CLI（本机核对 2.1.287，最低 2.1.248）；参数不支持时不能降级宽权限。

后续[混合故障回归](archive/server_mixed_validation.md)已完成并补齐R4的共享写锁和停止确认边界：运行端157项、实服基线24项、3轮108项、约5分钟10轮349项及Claude-b真实10阶段通过；新验证副本已保存关闭。新脚本`server-mixed-smoke.mjs`、`server-mixed-agent-trial.mjs`仍要求获授权隔离服及本批备份，不对普通存档运行。

[基础生存Alpha](archive/survival_alpha_plan.md)第一批背包／工具／进食已完成。10月3日第二批有限高差导航、自卫／退让、威胁与AI策略通过227项运行端、732项Java、55项真实程序及Claude-b五阶段；此前30分钟受控运行及独立短复验（生命值检查缺口见记录）见[第二批记录](archive/server_navigation_defense_validation.md)。10月5日新增R8、矿石实服及Codex生存／自然短回归见上方首版记录。所有本能共用写权，未知不自动重试；策略修改先停止旧活动任务。当前完整39工具；根规则中的33是较早快照数量，实际以capabilities和最新记录为准。持续陪挖与小型建筑随后分别交付。R6仅完成自身库存退化；R5／R7、R6剩余部分、多小时稳定性、真实Mod异常和Node24.15原生退出仍待做。文字“暂停”当前走宿主硬停止，Agent软暂停另有实际模式状态。

进度见`delivery_plan.md`；已完成的验收和架构评审材料在`archive/`（评审入口`archive/review_guide.md`）。整理前最近一次为143项Node检查、387项Java检查、23项真实程序检查，Claude和Codex各5个实际阶段。真实报告是历史执行记录，原始日志／存档仍留本地，不代表网页评审者已复现。整理版自己的离线复验另见`archive/export_validation.md`。
