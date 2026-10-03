# MCBOT Client Control（V1 原型）

真实 Minecraft 客户端的本机控制 Mod。当前绑定 **Minecraft 1.21.1 + NeoForge 21.1.217，Java 21**；只装 Bot 的客户端，服务器不需要安装 MCBOT。通用租约／操作协议在 `ControlSession`，版本相关游戏调用集中于 `MinecraftController`。没有 Mineflayer、OP 或 RCON 依赖。

**当前已编译、离线测试通过，真实客户端验收进行中。** Mod 自身不会登录账号、进入服务器或替用户安装其他 Mod。接入有内容 Mod 的服务器时，Bot 的真实客户端仍需装服务器要求的对应 Mod；这不是已经兼容全部整合包的承诺。

## 构建

在本目录用 PowerShell 7：

```powershell
$env:JAVA_HOME = 'D:/Java/jdk-21' # 换成自己的 JDK 21 路径
.\gradlew.bat build --console=plain
```

产物：`build/libs/mcbot-control-0.1.0.jar`。`build` 会执行 `controlTest`（普通 Java 测试入口），覆盖租约互斥／超时、同 ID 幂等、停止和新任务、世界代次、旧 ID 淘汰、认证／Origin／输入上限和主线程排队请求超时后不再执行。默认 JUnit `test` 任务不使用。构建无需打开 Minecraft；不会修改已有启动器实例、服务器或存档。

可用 `./gradlew.bat controlTest` 单独运行安全逻辑测试。测试临时开启随机端口的 loopback HTTP，不接游戏服务器，不调用 Agent，不计算文件哈希。

## 连接与控制权

安装并启动后，仅监听 `127.0.0.1:8765`，每次进程启动重新生成随机凭据并写入**实例目录**的 `config/mcbot-control/connection.json`。不向日志输出 token。多个 Bot 实例要通过 JVM 参数 `-Dmcbot.control.port=8766` 等指定不同端口。文件包含 token，请仅交给本机控制进程，不上传或提交。

协议见仓库 [`docs/client_body_protocol.md`](../../docs/client_body_protocol.md)。控制端读取 connection.json 后校验真实用户名、明确 worldId，申请独占租约，每 2 秒心跳；10 秒未续租会取消任务、松开按键。停止不退出游戏。离开世界、死亡、换维度或玩家实例变化立即使旧租约和句柄失效。死亡后不自动复活、回到旧任务。

`hello` 的 `username`／`sessionId` 在未进世界时明确返回 `null`；观察中的空 `container` 也保留为 `null`。`hello.screen` 只读返回当前菜单类名（无菜单为 `null`），用于辨别首启引导或连接界面，不提供操作界面的接口。

移动通过 NeoForge 的玩家输入事件注入，单格挖掘直接调用普通玩家交互管理器，不依赖操作系统按键、鼠标捕获或窗口焦点。多人服的 `PauseScreen` 可以保留，其他菜单和打开的物品容器仍会阻止世界动作；不会自动关闭界面。真正暂停的单人世界需要用户先恢复。用户在这个游戏窗口按键或点击鼠标即撤销控制租约，取消已有动作，让用户接管；之后需要控制器重新明确申请控制。

开发客户端使用独立的本模块 `run/` 目录，可在获得启动授权后运行：

```powershell
.\gradlew.bat runClient '-PbotUsername=ClientBot' '-PbotServer=127.0.0.1:25566'
```

`botUsername` 和 `botServer` 都是显式可选参数；不提供 `botServer` 时不自动进服。这个开发启动方式适用于本机离线测试服，不提供正版账号登录，也不能绕过在线服务器认证。本轮仅验证构建，未执行这条启动命令。

## 实现能力与边界

| 能力 | 当前行为 |
| --- | --- |
| 状态／附近实体／背包／聊天 | `source: client-observed` 表示客户端当前观察，可能包括本地预测，不代表服务端确认；实体最多 32 格内 64 个、聊天最近 100 条，命名空间 ID 不限原版；未知插件聊天不猜玩家名 |
| 转向、聊天 | 正常玩家视角／聊天发送；拒绝 `/` 命令；聊天成功只表示交给客户端连接 |
| 移动／跟随 | 限 32 格内平地直走，未实现完整寻路、跳跃或自动挖路；遇障碍、断崖、液体或已识别火／岩浆块停止；不保证识别内容 Mod 的全部危险地面 |
| 单格挖掘 | 校验明确 block ID、距离和视线，只允许目标一格，每个游戏 tick 调用原版 `startDestroyBlock`／`continueDestroyBlock`；无需鼠标捕获，控制期间的小型 Mixin 仅避免原版未按鼠标时重置该任务；观察变化后返回 `unknown`，不将预测当服务器确认 |
| 单格放置 | 当前只从快捷栏 0–8 选取预期方块物品，点击预期支撑面，目标必须为已加载空气；拒绝带方块实体／菜单的支撑；交互后返回 `unknown` 和目标观测 |
| 标准容器 | 只打开箱子、木桶、漏斗、发射器／投掷器、潜影盒、熔炉系列，需一个空快捷栏槽，防止右键回退使用手持物；收到菜单后才报告打开完成 |
| 槽位点击 | 标准存储／熔炉菜单的 `PICKUP` 单槽点击；同时校验菜单代次、槽位 ID／数量与光标物品 ID／数量，必填 `expectedCarriedItem`／`expectedCarriedCount`（空为 `minecraft:air`／0）；提供槽位及 `carried` 观测，点击后返回 `unknown`，需重新观察再决定下一次点击 |

移动默认容差 0.7 格（允许 0.25–3）；跟随默认距离 2.5 格（允许 1–8）。动作超时允许 500–120000ms，默认 15 秒，跟随默认 60 秒。跟随始终为 `running`，直到停止、失败或超时。身体动作串行，聊天／观察可并行。

最多保留 256 份操作结果，淘汰 ID 不允许重放；同一世界代次最多 4096 个动作 ID，达到后明确拒绝新动作，需重新进入世界。网络失败／响应超时不能自动重发变更操作。

后台动作修复的真实表现、服务器权限拒绝后的观测，以及至少一个内容 Mod 的真实游玩，仍需游戏验收。当前挖放及槽位没有精确服务端确认绑定，因此保守返回 `unknown`；这不等于失败，也不能据此自动重复操作。

事件绑定参考 [NeoForge 1.21.1 官方事件文档](https://docs.neoforged.net/docs/1.21.1/concepts/events/)，Mixin 采用 [Sponge 官方回调注入方式](https://github.com/SpongePowered/Mixin/wiki/Advanced-Mixin-Usage---Callback-Injectors)，具体交互与启动参数根据本地 1.21.1 源码编译核对。
