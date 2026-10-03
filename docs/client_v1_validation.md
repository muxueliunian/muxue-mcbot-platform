# V1 真实客户端验证记录

> 这是原开发环境的历史验证记录。原始日志、账号环境与测试存档未随整理版上传；整理版自己的复验见 [export_validation.md](export_validation.md)。
2026-10-02，时区 Asia/Tokyo。用户已批准启动独立 ClientBot 测试，并要求 Codex 独自验证、处理问题、继续开发。这里记录实际证据；总体状态以 [交付清单](delivery_plan.md) 为准。

**当前已停止本轮测试环境。** 用户随后提出双客户端对大型整合包的资源门槛问题，默认路线正在重评。11:43 左右正常关闭 ClientBot 和 25566 测试服，服务端确认各维度保存完成；25567 内容环境从未启动。保留全部产物与证据，不再继续新增客户端功能。

## 环境与恢复点

- 初始环境：`server-ysm-test/`，127.0.0.1:25566，MC 1.21.1／NeoForge 21.1.217，未安装 MCBOT 控制服务端桥。
- 开发客户端：`mods/mcbot-control/run/`，独立 ClientBot，控制通道 127.0.0.1:8765。主启动器实例不变。
- 开服前备份：`backups/client-v1-2026-10-02T02-07-30-008Z/world`，99 个文件、59,355,077 字节，逐字节核对一致；记录 `output/v1-backup-report.json`。
- 初始服务器 OP 清单只有 PlayerOne，ClientBot 是普通生存玩家。RCON 仅用于搭建明确的测试夹具和独立核对结果，不进入 Body 或 Agent 工具链。
- 测试区域 x=1000..1008、z=1000..1004、y=299..302，180 个位置确认均为空气后才添加 45 格平台和少量测试方块；没有拆除原有建筑。准备记录 `output/v1-fixture-setup.json`。测试准备传送不计作客户端自主移动。

## 已发现并处理的问题

1. **HTTP 空字段丢失**：真实 hello 缺少未连接时必有的 `username/sessionId:null`；空 `container` 同样受影响。根因是 Gson 默认序列化省略 null，旧测试只比较 Java JSON 对象。增加真实 HTTP 回归（修复前失败），启用 serializeNulls 后 12 项 Java 控制测试通过。真实客户端重启后已验证 `screen:null`、`container:null` 正常返回。
2. **首次启动引导挡住 Quick Play**：本地 MC 源码确认先显示辅助功能引导，完成后才处理启动连接。独立开发启动脚本初始化自身 options 的 onboardAccessibility/pauseOnLostFocus，并限制帧率／视距；重启后正常进服。只更改独立 run 目录。
3. **暂停菜单／失焦控制限制**：实际首次移动回执 `SCREEN_OPEN`，hello 的只读 screen 诊断为 PauseScreen。记录 `output/client-v1-move.json`。现已改为游戏内移动输入注入、原版目标挖掘调用，保留多人 PauseScreen，不调用桌面输入／焦点；真实复验通过。用户在该游戏窗口实际按键或点击会撤销租约。
4. **块操作确认**：此前挖放返回 unknown，测试独立核对服务端证明已成功。已继续实现入站单块／批量块更新确认，筛选当前连接、世界代次与操作目标；不以本地预测或 ack 单独认定成功。最新 build／16 项 Java 测试通过，但未加载到实际客户端，属于待游戏验收补丁。

## 游戏证据

| 场景 | 当前结果 | 证据 |
| --- | --- | --- |
| 真实客户端连接 | 通过；ClientBot 实际加入 25566 | 服务端 latest.log 与客户端 hello |
| 状态／背包／位置／空容器字段 | 通过 | `output/client-v1-inspect.json` |
| 直接停止与释放租约 | 请求确认通过，客户端保持同一连接；尚不替代运动中停止验证 | `output/client-v1-inspect.json` |
| 普通聊天 | Body 发送、客户端回读、服务器日志三处一致 | `output/client-v1-chat.json`，消息 `MCBOT V1 automated chat check` |
| 单格观察 | 正确识别测试泥土 `minecraft:dirt` | 同上 |
| 后台移动／运动中停止／新的移动 | 通过；真实 PauseScreen 下先发生位移，停止回执 16.2ms；300ms 稳定后再观察 1 秒无位移，新移动成功。回执耗时不是完整减速时间 | `output/client-v1-move-background.json` |
| 单格挖掘／放置 | 实际成功，原版泥土变空气、随后石头放入，服务器分别确认；当时工具均保守返回 unknown | `output/client-v1-dig.json`、`output/client-v1-place.json` |
| 标准容器 | 打开箱子、从槽 0 拿起 3 个圆石、放入槽 1、关闭均实际执行；服务器 Items 数据确认最终槽 1／count 3。槽位工具当时仍返回 unknown，未盲目重发 | `output/client-v1-open-container.json`、`output/client-v1-container-pickup.json`、`output/client-v1-container-deposit.json`、`output/client-v1-container-close.json` |
| 跟随／失控超时／死亡／跨维度 | 本轮尚未执行真实验证 | 保留离线与游戏验证的区别 |
| Codex 经新身体完整回合 | 尚未执行 | 与 Body 直接验证分开 |

## 内容 Mod 验证准备

选择 [Iron Furnaces 4.3.2 官方版本](https://modrinth.com/mod/iron-furnaces/version/WZ25JeYB)：MC 1.21.1 NeoForge，新增 `ironfurnaces:iron_furnace`。下载原包 576,866 字节；实际 jar 元数据确认 Minecraft `[1.21,1.22)`、NeoForge `[21.1,)`，两侧安装，无其他必需 Mod。来源及许可见官方页面，未做哈希计算／校验。

已准备 `runtime/v1-content-server/`：独立新超平坦世界、端口 25567／RCON 25577，仅安装 Iron Furnaces；复用本机 NeoForge libraries 目录联接，使用独立配置与存档。尚未启动，不改现有 25566 或正式服的 Mod 列表。先完成基础环境验证，再切换客户端和服务器场景。
