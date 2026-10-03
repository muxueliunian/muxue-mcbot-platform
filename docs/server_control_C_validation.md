# C：本机 Agent 真实陪玩验收（ServerBody）

> 这是原开发环境的历史验证记录。原始日志、账号环境与测试存档未随整理版上传；整理版自己的复验见 [export_validation.md](export_validation.md)。
2026-10-02 19:08–19:32（Asia/Tokyo）。C1–C3 用本机 Claude Code，C4 用 Codex／low，都控制同一个 ServerBody 角色 ServerBot。环境：MC 1.21.1／NeoForge 21.1.217 隔离服 `runtime/serverbody-validation`（游戏 25568、RCON 25578、控制口 8766，全部只听本机）。没有 Bot MC 客户端，正式服、启动器实例和人物记忆都没动。

## 结论

| 项 | 结果 |
| --- | --- |
| C1 启动与边界 | 通过。`start-server-play.ps1` 能启动；小克人设由 Agent 主机通过 `CLAUDE.md` 加载，模型自称小克，语气符合人设；实际 stdio 有 21 个工具，没有记忆类工具；游戏端文件里没有模型凭据 |
| C2 真实聊天驱动 | 通过。唤醒→查询、短跟随、单格挖、单格放、开箱取物、丢给玩家，都是模型自己调工具完成的，服务端结果有 RCON 独立核对 |
| C3 叫停与重启 | 通过。三种情况都验了：模型忙时叫停、Agent 进程被强杀、驱动整体重启。旧任务都没再执行，角色一直在线，之后的新任务第一次就成功。过程中发现两个缺陷，已修复并复验（见下文） |
| C4 Codex 短回归 | 通过。查询、放置、交还、忙时叫停、新任务第一次就成功。用户短体验还没安排 |

## 实测过程（按时间）

测试玩家 `TestPlayer` 由 `scripts/server-play-test-peer.mjs` 驱动（离线 Mineflayer，只负责说话和走动，不是 Body）。夹具用 RCON 布置：石台 y=200，箱子 (516,201,512) 放 5 个橡木原木，(512,201,514) 放一块泥土。

1. **唤醒和查询**：19:12:44 玩家问"你叫什么、在哪、状态" → 模型调 get-status，再 send-chat 回复"你好呀，我是小克…"，从发出到回复约 7 秒。
2. **跟随**：第一次是测试脚本自己出错，测试玩家走出台边掉下去被踢；ServerBot 跟到台边约 5 格后，以 `Only level-ground movement` 停下并如实说明。第二次测试玩家死后重生回了出生点，模型如实报告"超出 32 格"。第三次 ServerBot 从 (510.6,508.4) 跟到 (511.4,514.9)，约 6.5 格，然后被泥土夹具挡住，返回 `BLOCKED` 后停下说明。没有寻路，符合首版范围。
3. **单格挖**：get-block → dig-block 成功，RCON 确认那一格已经变成空气。
4. **单格放**：第一次被服务端以 STALE 拒绝（背包里的泥土从 3 块变成了 4 块）。模型重读背包后第二次成功，RCON 确认是泥土。
5. **容器与交还**：第一次开箱距离不够，模型先绕开障碍走近箱子（一次 BLOCKED，两次成功），然后 open-container → click-slot ×2（核对了 revision）→ close-container → select-slot → look-at → drop-item 5。箱子变空，测试玩家实际收到 5 个 oak_log。
6. **模型忙时叫停**：发"挖放三遍"，看到第一个 dig-block 后立刻发"停"（19:18:34.55）。宿主在同一秒撤销控制，正在进行的挖掘没完成（15 秒后泥土还在）。旧 Claude 5 秒没自己退出，被结束进程树。之后"新任务：挖掉一次"第一次就成功，控制代次从 4 变成 6。
7. **Agent 被强杀**：任务进行中用 `taskkill /F /T` 结束 claude（19:20:14.6）。强杀前已经完成的一次放置保留下来；宿主在 19:20:15 撤销控制，之后没有新的挖掘。新任务"看向我、报泥土数"第一次就成功。
8. **驱动整体重启**：`stop-companion.ps1` 后角色留服。停止期间测试玩家发一条"旧指令"，重启后模型没执行。新任务第一次就成功，控制代次到 14。
9. **Codex／low**：同一个角色、同一个测试玩家。查询 → 放泥土并丢 1 个圆石（玩家实收）→ 发"挖放三遍"后叫停（不到 1 秒撤销，Codex 1 秒内正常退出，挖掘没完成）→ "新任务：再丢 1 个圆石"第一次就成功（玩家圆石从 1 变成 2）。

模型调用统计（Claude＋Codex）：send-chat 21、get-status 14、get-block 12、get-operation 6、dig-block 5、list-inventory 5、place-block 4、look-at 4、follow-player 3、move-to-position 3、drop-item 3、open-container 2、click-slot 2、select-slot 2、close-container 1、find-entity 1、get-position 1、stop-action 1。

## 发现并已修复

1. **驱动漏读新 MCP 的事件**（`scripts/companion.mjs`）。新 MCP 进程会原地清空事件文件再重写，驱动以前只靠"文件变短"判断换了文件。新文件和旧文件一样长（这次两边都只有一行 spawn，各 230 字节）时，驱动把新事件当成已读；新文件更长时，会从一行中间开始读，丢掉事件。旧 Mineflayer 路径也有这个问题。修法：同时比较首行的 session 和 mtime。新增回归测试「新 MCP 原地重写的事件文件和旧文件一样长或更长」。真实重启复验时，spawn 事件已经能正常处理。
2. **接管前的聊天对模型可见**（`client-runtime/src/mcp.ts`、`main.ts`）。事件通道本来就跳过接管前的历史，但 get-status／read-chat 仍然会返回这些旧聊天。第一次重启时，模型能读到两条旧指令，没执行它们只是因为按提示自觉忽略。修法：ServerBody 按 claim 返回的 chatCursor 过滤，ClientBody 不变。新增 stdio 测试（去掉修复时失败）。复验时模型报告"聊天为空，接管前的一条被跳过、没看到内容"。

回归：`client-runtime` **42／42**；旧路径完整 build＋test **307 项：306 通过、0 失败、1 跳过**（跳过的是需要显式启用的真实窗口截图）。

## 还没处理的问题

- **上下文涨得快**：每个 task 事件和观察都带着完整背包和全部 typed 组件，单个事件约 3k token。Claude 会话做完 6 个小任务，上下文从 48k 涨到 108k。另外，模型已经用 get-operation 确认过的完成事件，还会再触发一轮（约 4 秒、多花一点费用）。建议精简给模型看的事件和观察，但动作核验仍然要用完整组件。
- **Codex 停止后有残留文件**：MCP 被直接结束、没走清理，留下了 `server-control-*.json` 和锁文件。锁的 pid 失效后会自愈，租约也已被宿主撤销，但这和协议里"退出时只删除属于自己的文件"不一致。本轮已手动删除。
- **默认 Claude 账号登录过期**（`~/.claude` 显示未登录），本轮改用已登录的 `<selected-claude-config>`（`-ConfigDir`）。驱动在游戏外的日志里正确报了登录问题。
- **模型准确性**：Claude 在 CLI 小结里把自己背包里的钻石说成"箱子里的"，没对玩家说错。Codex 是独立身份，回复带"收到"这类公事口吻，和小克的人设无关。
- 跟随／移动只走平地，单个方块就能挡住，这符合首版范围。

## 我自己的失误

- 想查 OP 列表时误发了 `op list`，结果把名为 "list" 的离线玩家设成了 OP。发现后立即 `deop list`，`ops.json` 与备份逐字节相同。期间没有这个玩家进服。
- 测试玩家走路的时间设长了，掉出平台，原因见上文第 2 条。

## 环境与收尾

- 开始前备份到 `backups/serverbody-C-20261002-190834/`：世界 87 个文件、27,559,219 字节，逐字节相同；同时备份了 server.properties、ops.json、whitelist.json、控制配置和 jar。
- 以普通模式启动，没开 `mcbot.validationFixture`。临时 forceload 已移除，keepInventory 仍是 false。
- 19:31 保存并关服，25568／25578／8766 都没有监听。`server.properties` 只有启动时自动写的时间戳不同，已从备份恢复为字节相同；ops.json、whitelist.json、jar 与备份相同。
- 存档里保留了这些测试改动：箱子已空、(512,201,514) 是空气、地上有掉落物、ServerBot 背包变化、TestPlayer 的存档。
- 证据：`output/c-play/`（驱动日志副本、测试玩家事件 JSONL、工具清单脚本）、`output/serverbody-C-server.log`。
- 已有的未提交改动全部保留，没有提交或推送。

## 用户短体验准备（C4 后半，未进行）

版本：MC 1.21.1 + NeoForge 21.1.217（实例 `mcbot_1.21.1_NeoForge` 能直接连）；地址 `127.0.0.1:25568`；在平台 (514,201,512) 附近。步骤：先启动验证服，再运行 `.\start-server-play.ps1 -ConnectionFile runtime\serverbody-validation\config\mcbot-server-control\connection.json -ConfigDir $HOME\<selected-claude-config> -Headless`，然后在游戏里依次说：打招呼 → 叫跟随 → 叫挖或放一格 → 叫取箱子并交还 → 说"停" → 给新任务。验证服白名单关闭、是离线模式，PlayerOne 可以直接进。
