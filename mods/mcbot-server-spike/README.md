# ServerBody G0/G1 验证组件

仅用于隔离实验服，Minecraft 1.21.1 / NeoForge 21.1.217 / Java 21。
它不是正式 ServerBody，不接 HTTP、MCP、Agent 或模型，不承诺通用 Mod 兼容。

构建：在本目录用 PowerShell 7 设置 `$env:JAVA_HOME='D:/Java/jdk-21'` 后执行 `./gradlew.bat build`。
产物：`build/libs/mcbot-server-spike-0.1.0.jar`。构建成功仅代表编译通过，无内置游戏测试。

控制台或 OP（权限等级 2）实验命令：

- `/mcbot-spike spawn <x> <y> <z>`：在命令来源维度的指定 fixture 坐标创建 ServerBot；初始化位置使用传送。
- `/mcbot-spike status`：返回 `MCBOT_SPIKE ` 前缀的 JSON。
- `/mcbot-spike move <x方向> <z方向> <ticks>`：方向分量范围 -1 到 1，持续 1–100 tick；方向归一为前进，无寻路或跳跃。
- `/mcbot-spike stop`：清除主动输入；碰撞、重力和已有惯性继续正常执行。
- `/mcbot-spike remove`：正常离线并清理登记；重复调用安全。

名称固定 ServerBot，UUID 使用固定 literal `9c6882e0-e80c-4c3e-8f20-8e3f42c738a1`，拒绝重复生成和 OP 身份。
普通 `ServerPlayer` 生存模式，具有正常血量、饥饿、受伤、碰撞和重力；没有额外无敌规则，出生保护仍服从原版。
通过原版 `PlayerList.placeNewPlayer` 登记以保持 PlayerInfo 在实体生成前、支持后来加入的观察者。
虚拟连接接收并丢弃仅供客户端消费的数据包；虚拟 listener 单独捕获本体 entityId 的速度包，供本体下一次物理 tick 使用。不建立 Minecraft socket，不注册真实网络连接轮询。

世界实体 tick 负责一次 `ServerPlayer.tick()` 和一次 `doTick()`，按服务器 tick 计数防重复。
虚拟 listener 的 tick 不运行原版网络位置回滚逻辑；每次物理 tick 后运行原版网络路径负责的摔伤检查。
移动输入同时有 tick 与单调时钟时限，恢复世界 tick 时先清除过期输入；这不能代替单机暂停实测。
独立服务器 tick 事件仅清理已移除/断连引用，不驱动物理。

2026-10-02 实测发现受击缺陷：普通生存观察者与本体相距 2.5 格、无遮挡且没有主动输入时，空手攻击使血量从 16.666668 降至 15.666668，但随后 10 次、每次间隔 100ms 的位置采样位移均为 0（`output/serverbody-hit-before-fix-2.json`）。本地 1.21.1 源码中，`Player.attack` 向受击 `ServerPlayer` 发送 `ClientboundSetEntityMotionPacket` 后恢复旧速度；虚拟 listener 丢包后没有客户端接收击退，因此会失去这次速度。

修复仅保留最近一个发给本体的绝对速度，下一次 `SpikePlayer.doTick()` 在普通物理之前取出、清空并替换 delta；不累加速度、不运行原版 listener tick、不修改 `hurtMarked`，`stop` 只清主动输入。移除时丢弃待消费速度，重新创建的 listener 使用全新队列和计数。`status` 的 `ownMotionPacketsQueued`、`ownMotionPacketsConsumed` 和 `ownMotionPending` 用于观察本体速度包的排队与消费。该修复针对已经复现的原版玩家攻击路径；其他 Mod 在发包后再次修改 delta 的次序尚未验证。

修复后真实 hit 回归通过：空手一次攻击扣 1 血，水平击退约 1.989 格，自身速度包排队和消费各 1 次；观察者同步与运动收敛通过。G0 的 61 项、G1 的 43 项、hit 的 34 项断言均通过，彼此有重复，不相加成独立场景数量。详情与证据路径见 [验证记录](../../docs/server_body_validation.md)。从项目根目录用 `node scripts/server-body-spike-smoke.mjs --help` 查看隔离服测试方式；必须先备份，脚本不负责开服。

已知边界：没有交互动作、权限保护兼容验收、跨维度/死亡重生策略和客户端视觉。
首次生成会走原版登录加载 playerdata；显式 fixture 定位覆盖持久位置，重复生成并不清空背包/血量。
原版登录会先创建临时 listener，随后替换为虚拟 listener；正式实现需重新评审完整生命周期。
本组件不包含资源成本门槛，验收重点是正确性和默认无需第二客户端。
