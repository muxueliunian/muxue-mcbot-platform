# V1 真实客户端原型

2026-10-02。本轮已实现独立客户端控制链路的首个增量。游戏安装与试玩须单独确认；编译／离线测试不代表已经进服验收。当前进度统一记录在 [交付清单](delivery_plan.md)。

**当前状态更新：已获授权并完成部分真实测试，见 [验证记录](client_v1_validation.md)。用户随后提出双客户端资源门槛，测试环境已关闭，默认身体路线重评；以下构建／启动说明保留，不代表继续以本地双客户端为默认。**

## 组成

- `mods/mcbot-control/`：MC 1.21.1／NeoForge 21.1.217 客户端 Mod，提供本机控制通道；通过正常玩家交互操作。客户端进程独立于 Agent。
- `client-runtime/`：独立 Node 包，最小 Body 类型、ClientBody 和 MCP 工具。安装及运行依赖不包含 Mineflayer；旧 `mcp-server/` 入口继续保留。
- `start-client-play.ps1`：生成隔离配置，复用 Codex 托管、聊天事件唤醒与快捷停止；思考固定默认 low。
- [协议 v1](client_body_protocol.md)：认证、控制权、操作结果及世界代次。MC／加载器绑定放在 Mod，Agent 不接触 Java 类型。

独立 MCP 可供不同 Agent 配置；本轮托管入口只验 Codex。DeepSeek Harness、原生 API 和新版 Antigravity 仍按 V2 推进。

本轮离线结果：旧功能及新驱动接线完整回归 299 通过、1 跳过；新运行端 15 项通过；Mod 控制／通道 11 项通过，jar 构建与开发启动参数生成成功。新包的 stdio 进程已验证 19 个工具和拒绝 Mineflayer 导入；没有运行真实模型或进入游戏。这些结果按测试集合分别记录，不与先前重叠回归累加。

## 构建与配置

使用 PowerShell 7：

```powershell
cd <repo>\client-runtime
npm install
npm test
cd ..\mods\mcbot-control
$env:JAVA_HOME = 'D:/Java/jdk-21'
.\gradlew.bat build
```

控制 Mod 只安装到专门供 Bot 使用的客户端。不要将控制通道指向正在由真人操作的客户端。独立 Bot 必须具有目标服务器允许、能与主人同时在线的身份；本地离线测试身份不能当作正版服务器账号。

Mod 启动后把本机连接地址与随机 token 写入该实例的 `config/mcbot-control/connection.json`。该文件只保留本机，配置文件及日志中只传文件路径。默认端口 8765；多个客户端需给控制 Mod 设置不同端口。

客户端进入世界后，在仓库根目录运行：

```powershell
.\start-client-play.ps1 `
  -ConnectionFile '<独立Bot实例>/config/mcbot-control/connection.json' `
  -WorldId 'v1-prototype-test-world' `
  -Name ClientBot `
  -PrepareOnly
```

检查 `runtime/client-play/ClientBot/mcp.json` 后，移除 `-PrepareOnly` 开始托管。脚本不启动游戏、不登录账号、不安装 Mod、不改服务器。目标客户端名必须与 `-Name` 相同；`WorldId` 必须明确对应当前世界的资料范围。

停止托管用 `.\stop-companion.ps1 ClientBot`；停止游戏动作直接在聊天说“停下”。停止动作和 Agent 进程重启不会有意关闭 Java 客户端。运行端退出时释放控制权，异常消失时由客户端租约过期停止动作。

## 原型边界

- 状态／库存／实体／局部方块来自客户端当前观察，可能包括本地预测；未加载方块不会表示为空气。
- 只有一个控制者和一个持续身体动作。聊天与观察可并行；停止独立处理。`running` 只表示执行中，用 `get-operation` 查询。
- 移动／跟随是有期限的短距离原型，遇阻或危险会失败，不含旧 Mineflayer 的完整寻路、挖路和陪挖功能。
- 挖放须指定目标 ID，放置仅选快捷栏槽位；标准容器操作要指定当前窗口句柄、预期槽位内容和鼠标携带栈。自定义机器／菜单需后续适配器。
- 客户端预测不能作为服务端成功证据；`unknown` 需要重新观察，不可盲目重发投料、点击、放置等变更。
- 退出世界、死亡、切换维度或控制租约失效后，不自动跨世界接管；首版重新进入世界后需手动重启托管。旧窗口、旧操作与旧任务不沿用。
- 当前入口未迁移长期记忆、视觉、自动进食、战斗和复杂建造。第二版本／加载器、内容 Mod 场景尚待实际验收。

## 游戏验收安排

独立开发入口为仓库根目录的 `.\start-client-dev.ps1`：使用 JDK 21，在 `mods/mcbot-control/run/` 运行 ClientBot，显式快速连接 `127.0.0.1:25566`。已生成并核对用户名／服务器启动参数；实际启动尚未执行。该开发身份只适用于允许离线测试身份的服务器。

先用独立开发客户端 `ClientBot` 进入现有 25566 测试服，检查状态、聊天、短距离移动、快捷停止、控制端重启后客户端仍在线。随后在明确可改动的区域验证单格挖放和标准容器、失控停止与世界代次。

内容 Mod 需另选具体组合，在独立测试环境中检验新方块碰撞、挖放和容器；现有 YSM 成功不能替代内容 Mod 验收。不把测试准备使用的服主权限／RCON 当成客户端基础运行依赖。

安装／启动独立测试客户端前按根目录 `AGENT.md` 说明影响并获同意。产物、命令和离线结果准备好后再申请；主实例、正式服、现有存档均不由构建命令修改。
