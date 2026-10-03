# D：Iron Furnaces普通炉菜单验证（2026-10-03）

> 这是原开发环境的历史验证记录。原始日志、账号环境与测试存档未随整理版上传；整理版自己的复验见 [export_validation.md](export_validation.md)。
在独立 `runtime/v1-content-server/` 上验证 Iron Furnaces 4.3.2、Minecraft 1.21.1、NeoForge 21.1.217 与 ServerBody共享任务接口。游戏端口25567／RCON25577／控制口8767仅监听127.0.0.1；角色ModBot，worldId为`ironfurnaces-validation`。脚本 [server-body-content-smoke.mjs](../scripts/server-body-content-smoke.mjs) 使用实际stdio MCP，不启动模型、协议测试玩家或额外Minecraft客户端。

## 环境备份

启动前检查三个端口无监听；目录原来只有Iron Furnaces jar、eula、server.properties、JVM参数及libraries联接，实际没有world／config／ops／whitelist。没有假定旧文档中的“未启动”，而是核对磁盘状态后生成 备份证据（本地证据未随仓库分发：`../output/serverbody-content-backup.json`）：4个文件／577,440字节，备份为`backups/serverbody-content-D-2026-10-03-2026-10-03T01-16-04-145Z/`，复制后逐文件直接比较实际字节相等。libraries junction未遍历、未改动，未计算任何哈希或指纹。

只为此环境新增独立控制配置及构建控制Mod，原Iron Furnaces jar保留。RCON只准备专用高空安全平台、普通未运转炉的output组件栈与隐藏槽探针，并独立读取实际机槽和Bot库存。不修改正式服务器、启动器实例或25568测试环境。

## 支持边界与实际验收

本轮Adapter门控到确切版本、block／BlockEntity／menu类和55槽原生契约，仅普通未运转`ironfurnaces:iron_furnace`，`lit=false,type=0`及普通furnace菜单；工厂／发电／升级界面和其他炉等级不在支持范围。实际菜单0–18属于同一机器库存，其中0/1/2在普通模式活跃，其他机器槽保留`active:false`；19–45映射玩家inventory9–35，46–54映射hotbar0–8。源判断以实际 backing inventory／InvWrapper身份为准，不把末尾36格当作未经核验的通用猜测。

实际运行记录（本地证据未随仓库分发：`../output/serverbody-content.json`） 最终完整运行 **27／27通过**，耗时5,784毫秒；该耗时是无模型的单次本机脚本矩阵时间，不能当作真实模型回应或稳定性能门槛。安装记录（本地证据未随仓库分发：`../output/serverbody-content-install.json`） 为111,035字节控制jar，安装与构建产物逐字节相等，Java21构建163项检查通过；Node构建85项测试通过（构建测试由实现任务执行）。

| 场景 | 验收事实 | 状态 |
| --- | --- | --- |
| 非OP、普通距离 | ModBot无OP；6格外普通open拒绝且机槽不变 | 通过 |
| 发现与通用container-list | 同任务入口自动走近、开炉、只列活跃机槽、关炉，不把Bot或隐藏工厂探针算作输出 | 通过 |
| 实际库存来源及组件 | 55槽原生映射；output3铁锭带custom_name与nested custom_data完整可读；玩家钻石5分属player | 通过 |
| hidden factory stack | 隐藏槽13的11钻石不能被通用withdraw当作源，实际机槽字段不变 | 通过 |
| 未验证的部分输出回填 | 从3个输出取2时明确拒绝，不消费输出 | 通过 |
| 通用whole-stack withdraw | 整栈3铁锭移入空快捷栏，源empty，完整组件保持，Bot自身钻石5不变 | 通过 |
| inactive upgrade／factory槽原子click | 活跃性为false时以UNSUPPORTED拒绝3/6/13槽，不改变机槽或cursor | 通过 |
| 未适配炉等级 | gold_furnace不被发现宣称支持，直接open以UNSUPPORTED拒绝 | 通过 |
| 移动中叫停与首个新任务 | relay暂停approach回执；stop后不开炉、不取物，首次新list成功 | 通过 |
| 全空Mod炉挖放闭环 | 独立全空炉，原生钻石镐dig移除→工具damage增加→真实namespaced物品drop→普通走近原生pickup1→原生place恢复炉并消费1，放后机槽仍全空 | 通过 |

首轮真实验证发现Adapter把`mayPickup`误用于向空玩家槽放物：输出pickup成功，空目的SlotItemHandler的`active:true,mayPickup:false`被错误拒绝。`mayPickup:false`只表示空槽没有可拿内容，不能据此拒绝普通放入。失败记录保留 attempt1（本地证据未随仓库分发：`../output/serverbody-content-attempt1.json`）；未重试取物，释放MCP时原生关菜单把carried3铁锭归入ModBot hotbar0，RCON独立核对来源输出空、Bot3且完整custom_data保持。此失败不是支持证明，修复后的最后一次完整运行单独记录。

第二次已经通过容器主线与原生dig，但验证脚本错误地要求掉落实体selector结果整行等于`Test passed`，实际服务端返回`Test passed, count: 1`。记录保留 attempt2（本地证据未随仓库分发：`../output/serverbody-content-attempt2.json`）；独立掉落排查（本地证据未随仓库分发：`../output/serverbody-content-drop-investigation.json`） 确认真正生成1个`ironfurnaces:iron_furnace`，Bot尚未拾取，doTileDrops=true。只修正断言格式后最后完整复跑27项通过，没有由RCON补一个物品冒充原生掉落或拾取。

本轮验证普通未运转炉的槽读取／整栈取物，以及专用全空炉的挖掉／拾取／放回消费；没有验收熔炼、发电、Factory运转、GUI全功能、自动机器管理或任意内容Mod通用支持。精确菜单Adapter带有版本限制，超出模式必须拒绝，不能扩大授权。

## 收尾与交接

已经执行`save-all flush`及`stop`，隐藏Java PID22936退出，25567／25577／8767无监听；MCP已关闭并释放租约。关服前普通`list`仅ModBot，Health20，Overworld无强加载区块，见 停服前权威状态（本地证据未随仓库分发：`../output/serverbody-content-prestop.json`）。清理记录（本地证据未随仓库分发：`../output/serverbody-content-cleanup.json`） 记录原始4文件全恢复备份实际字节，原Iron Furnaces jar也直接相等；111,035字节控制jar保留且仍与build实际字节相等。首次新生成world及config保留为可启动的独立D环境；libraries junction仍指向原`server-ysm-test/libraries`，未修改联接内容。无OP新增、无模型或账号凭据放入游戏端。

后续继续使用中文、Windows PowerShell7，保留未提交改动；非必要禁止任何哈希／指纹，文件与结果回归直接比较实际字节／字段。
