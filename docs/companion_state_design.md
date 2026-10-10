# 陪伴状态设计：姿态、任务、打断

2026-10-10 起草。起因是用户觉得托管时的状态管理设计得不好（8l 刚把跟随改成持续状态，但守卫、跟随、建筑、临时小任务之间的关系还是乱的）。本文先整理现状和问题，再定分层目标和分步路线；**第一步是守卫和跟随解耦**，详细设计见第 5 节。同一天的外部陪伴体验评审见 [companion_experience_review.md](companion_experience_review.md)，其中第 5 条与本文第一步是同一个问题。

状态：第 6 节的三个问题用户 10-10 已定。第一步分两块做：
- **第一块（10-10，离线完成）**：服务端常驻保护（`GuardDuty`、协议方法 `guard`、观察里的 `guard`），空闲、原地等待、跟随时都能保护，等待中打完走回原位；运行端改用它（跟随让开、等待都不关保护，`companion-mode stop`／`stop-action` 关）。协议见 [server_body_protocol.md](server_body_protocol.md#常驻保护8m-第一步第一块2026-10-10)。离线：Java `GuardDutyTest` 17 项、`ControlSessionTest` 和 `FollowCompanionTest` 补的检查，运行端 `companion-guard-duty.test.mjs` 5 项；没有隔离服实测、没有真实模型试玩。
- **第二块（10-10，离线＋隔离服完成）**：5.2 表里的任务打断和期限顺延，能力`guard-duty-tasks`，协议见 [server_body_protocol.md](server_body_protocol.md#保护打断任务8m-第一步第二块2026-10-10)。和 5.2 表的出入：`emote`手势不打断（几秒就完，打断反而要多处理一个被取消的操作）；`approach-player`不打断（玩家一动它就失败）；走向床可打断。没有改“打架开始前在路上挨打就 `BLOCKED`”的规则，打完后才把受伤基线重置。隔离服`server-guard-duty-smoke`8 项通过（等待、地面建筑、垫脚柱上不打、玩家太远），没有真实模型试玩；合成界面开着时只有离线检查。

## 1. 现状：状态分在三层

| 层 | 状态在哪 | 怎么组织 |
| --- | --- | --- |
| 服务端会话 | `ControlSession.java` | 同一时间只有一个 running 操作（`send-chat` 除外）；每次 `stop` 都让 `controlGeneration` 加一，并调 `game.stop()` |
| 服务端执行 | `ServerController.java` | 十几个可空字段（`companion`、`pickup`、`pillar`、`station`、`job`、`build`、`farm`、`breed`、`travel`、`navigation`、`sleepBed`、`retreatTarget`……）实际上是“只有一个非空”；`beforePhysics` 用一串 `if` 决定这一刻驱动谁，顺序就是隐含的优先级；`stop()` 一次清空全部 |
| 运行端 | `client-runtime/src/` | 6 个各自独立的“任务主人”：`ContainerTasks`、`GatherTasks`、`SurvivalTasks`、`PillarTasks`、`CompanionMode`、`SurvivalReflexes`，各有一套 epoch／active／stopping／`cancel()`／`stopped()`；合成、烧炼、建筑、长途走、种地等工具没有主人，直接 `body.act`，运行端只能从 `pendingOperations()` 看出它们在跑 |

`CompanionMode` 单独有约 15 个互相牵连的状态变量：`state`（6 种）、`intent`、`activity`、`suspendedFor`、`awaitingPlayer`、`leases`、`childActive`、`changing`、`stopping`、`stopUnconfirmed`、`epoch`、`observationRevision`、`resumeTimer`、`pickup`、`mining`。

## 2. 问题

1. **守卫挂在跟随底下（最影响体验）**。保护玩家只是 `follow-companion` 操作的 `guard` 参数，`GuardCombat` 只在 `FollowCompanion.tick()` 里跑。所以：
   - 原地等待时不能保护（`companion-mode.ts` 的 guard 分支直接拒绝 wait）。
   - 任何占用身体的工具（建筑、采集、合成、长途走，甚至 `emote`）一开始，跟随就让开，服务端的 follow 操作被停掉，**保护跟着没了**，只剩运行端 3 格近身自卫，而且只护 Bot 自己。“帮我砍树，同时保护我”在行为上有空档。
2. **跟随“让开”是拆掉再重建**。持续意图在服务端只是一个普通操作。每次让开：pause → `body.stop()`（代次加一）→ 跑工具 → 身体空闲满 3 秒 → 重新观察 → 再提交一次 `follow-companion`。因此到处是“新代次还算不算我的”检查（`adoptable`、`exactlyNext`、`internalStop`），还需要补丁：`resumeDelayMs = 3000` 防止两次工具调用之间跟随把身体带走；`emote` 在租约里 sleep 等动画放完，防止跟随提前接上。
3. **CompanionMode 既是模式又是调度器**。陪挖、陪捡作为跟随的子任务塞在里面（`mineBlock`、`pickupItem`、`returnFromMining`、`block`），和 `GatherTasks` 靠借锁（`borrowed`）配合，约占 600 行里的一半。
4. **任务没有统一模型，“忙不忙”的判断散在多处且不一致**。`tasks.assertIdle(); gather.assertIdle(); survival?.assertIdle()` 在 `idleBody`、`busyProbe`、`ordinaryBusy`、`pauseCompanion`、`PillarTasks` 各写一遍；普通原子动作只查 `tasks.assertIdle()`；`busyProbe` 不查垫高（靠身体写锁兜底）。新加一个工具要同时改 `bodyTools` 集合、`idleBody`、Codex 白名单、服务端 begin／tick／stop，漏一处不报错。
5. **打断后的处理不一致**。跟随、等待被自卫或进食打断后会自动接上；建筑、种地、长途走被打断就取消（“不重放旧任务”），模型得自己发现再调一次。可这几个任务本来就是按世界现状重新规划的，能安全续做（建筑已支持“同样参数再调一次接着盖”）。
6. **小动作也走整套让开**。`look-at`、`emote`、`select-slot`、`equip-item` 不移动身体，也会触发让开、换代次、等 3 秒、重新跟随。

## 3. 目标：三层

参照原版生物的 `GoalSelector`（按优先级排的行为，加 MOVE／LOOK 这类互斥标志）：

1. **姿态层（常驻，在服务端）**：跟随、等待、守在某处；**保护谁**是独立的一项，和跟随正交。有任务时姿态在服务端挂起，任务结束后服务端自己恢复，不需要运行端重新提交、也不换代次。
2. **任务层（同时一个）**：统一生命周期 running／suspended／succeeded／failed／cancelled／unknown，每个任务声明能不能续做、此刻能不能被打断。
3. **打断层（按优先级抢占）**：保护玩家 > 近身自卫 > 紧急进食 > 普通进食，统一走“挂起当前任务 → 处理 → 恢复”。

运行端相应改成一个调度器，替代 6 个主人各自的 epoch 和空闲检查；每个工具在注册时声明属性（占不占移动、能否续做、能被谁打断），去掉 `bodyTools` 这类集合和重复的 `assertIdle`。

叫停也分开（与评审第 1 条一致）：暂停当前动作、取消当前任务、紧急停止（清掉所有姿态和保护）是三件事。

## 4. 分步路线

每一步都能单独上线、单独验收：

| 步 | 内容 | 主要改动 | 估计 |
| --- | --- | --- | --- |
| 1 | **守卫解耦**：保护玩家变成服务端独立的常驻职责，在等待、做任务时都有效（第 5 节） | 服务端新职责层和协议方法；任务的可打断点和期限顺延；运行端 `GuardDuty` | 2.5～3.5 天 |
| 2 | **姿态在服务端挂起／恢复**：跟随、等待成为服务端姿态，让开不再拆掉重建 | `FollowCompanion` 从操作改成姿态；`CompanionMode` 去掉让开、代次接纳逻辑 | 待第 1 步后评估 |
| 3 | **小动作不打断姿态**：按 MOVE／LOOK 标志区分，`look-at`、`emote`、选格、穿装备不让开。10-11 先做了 select-slot、equip-item；emote、look-at 仍让开，待第 2 步后再做 | 工具属性表 | 0.5 天 |
| 4 | **统一任务生命周期**：运行端单一调度器；建筑、种地、长途走被打断后续做 | 合并 6 个任务主人的公共部分；服务端可空字段改成一个任务槽 | 待评估 |

陪挖、陪捡（问题 3）在第 2、4 步里一起拆：子任务交给统一调度器，`CompanionMode` 只留姿态。

## 5. 第一步：守卫解耦（详细设计）

### 5.1 目标

- 保护玩家是独立的常驻职责（下称“保护”），绑定一个玩家（名字＋UUID）和选项（范围、撤退血量、弓、盾）。
- 跟随、等待、做任务、空闲时，保护都在；跟随让开不影响保护。
- 打怪时暂时接管身体，打完把身体交还给原来在做的事（姿态或任务），任务的期限把打架的时间顺延。
- 战斗逻辑（`GuardCombat` 的选目标、近战、弓、盾、撤退、躲苦力怕、防误伤）不改，只改它挂在哪、谁来 tick。

不在这一步做：跟随本身改成姿态（第 2 步）；被进食、自卫打断的任务续做（第 4 步）。

### 5.2 服务端

**新的职责层**。`ServerController` 加一个字段 `GuardDuty duty`，不属于任何操作：

- 内容：被保护玩家的名字和 UUID、`GuardCombat.Options`、一个 `GuardCombat` 实例、打架累计时长、最后一次的覆盖状态。
- 生命周期按租约算，不按操作算：`stop`（代次加一）**不清**保护；`revoke`、`release`、新的 `claim`、`bodyChanged`（死亡、换维度、移除）清掉。紧急停止可以在 `stop` 上带 `clearGuard:true` 一起清（见 6.1）。
- 现在 `GuardCombat.create` 里的导航用 `new NativeNavigation(body, session, operation)`，按操作判断能不能驱动。保护不属于操作，需要一个按租约判断的版本（例如 `session.mayDriveDuty()`：租约有效、身体在线、代次不限）。

**tick 顺序**。`beforePhysics` 在 `survival.tick()` 之后、任务链之前：

```
if (duty != null && duty.wantsBody(...) && interruptible(当前任务)) {
    若当前任务还没被挂起：task.suspend()（停输入、丢掉导航路线），记下开始时间
    duty.tick() 驱动身体，本刻不 tick 任务
} else {
    若刚打完：task.resume()（重新寻路），期限顺延打架时长
    照旧 tick 当前任务（没有任务时就是空闲凝视）
}
```

`wantsBody` 就是现在 `GuardCombat.tick()` 返回 true 的那些情况（接近、近战、拉弓、举盾、撤退、躲闪）。

**交战范围**。保护只在 Bot 离被保护玩家 16 格以内时才接管身体（6.2）。超出时保护处于“不覆盖”状态，不去打，运行端的 3 格近身自卫照常起作用。

**哪些时刻可以打断**（`interruptible`）。默认不可打断，逐个任务放开：

| 当前在做 | 可打断 | 说明 |
| --- | --- | --- |
| 空闲、等待 | 是 | 等待目前只在运行端，服务端看到的就是空闲 |
| `follow-companion`、`follow-player`、`move-to-position`、`approach-*`、`travel-to` | 是 | 打完后导航重算路线（跟随现在就是这么做的：`resetNavigation`） |
| `build` | 站在地上、不在垫脚柱和屋顶上时 | `BuildTask` 自己报告此刻是否在柱上（`scaffold`、`Mode.UP/RISING/DESCENDING/COLLECT`） |
| `tend-crops`、`breed-animals` | 走路时是；在原生使用物品（喂食、骨粉）时否 | |
| `craft-item`、`smelt-item`、`produce-item`、`modify-item` | 走向工作站时是；界面打开后否 | 中途关菜单可能丢东西，宁可等它做完 |
| 开着的容器（`open-container` 后）、`click-slot` | 否 | 同上 |
| `pillar-up`、`sleep-in-bed`（已躺下）、进食等原生使用、`dig-block` 正在挖 | 否 | 都很短，或者打断有危险；原子挖掘完成后再接管 |
| `emote` 手势 | 是 | 直接取消手势 |
| `pickup-item` | 是 | 打完重新走向物品 |

**期限顺延**。`ServerController` 的 `actionDeadline` 加上打架时长；自带期限的任务（`BuildTask`、`TravelTask`、`FarmTask`、`BreedTask`、工作站任务）加 `extendDeadline(ms)`。运行端自己计时的任务（`GatherTasks` 默认 60 秒、`ContainerTasks` 90 秒）读观察里的保护累计时长，按增量顺延，不然一场长架会让采集超时失败。

**跟随里的旧保护**。过渡期保留 `follow-companion` 的 `guard` 参数（旧运行端还用）。身体声明新能力 `guard-duty` 后，新运行端不再给 follow 传 `guard`，改用职责层；`FollowCompanion` 在职责层保护同一个玩家时不再自己 tick 保护。实测通过后删掉旧路径。

**协议**（写进 [server_body_protocol.md](server_body_protocol.md)）：

- 能力 `guard-duty`。
- 新方法 `guard`：需要租约（和 `heartbeat` 一样校验 instance／session／lease），**不是操作**：不占操作 ID 预算，不会和正在跑的操作冲突报 `BUSY`。参数 `{player, expectedEntityId, options}` 打开或修改，`{off:true}` 关掉；返回当前保护状态。玩家不在 32 格内或 UUID 不符时拒绝打开。
- `observe` 在保护开着时多一个 `guard`：`{player, entityId, options, covering, reason?, state, target?, targetId?, hits, damage, shots, kills, retreats, busyMs}`。`covering` 为 false 时 `reason` 说明为什么（玩家太远、玩家下线、换了维度、当前任务不可打断）；`busyMs` 是打架累计时长。
- 玩家下线、换维度、超出范围时保护进入不覆盖状态，**不自动关**；玩家回来后继续保护（同一 UUID）（6.1）。
- 空闲（运行端在等待）时打完，服务端把身体走回开始打之前站的位置（6.3）；有任务时交还给任务，由任务自己重新寻路。
- 防误伤（Bot 的伤害落到玩家、宠物、村民、有名字的生物上时取消）不变。

### 5.3 运行端

- 新文件 `client-runtime/src/guard-duty.ts`：保存运行端想要的保护（玩家、选项），调新增的 `Body.setGuard()`（ServerBody 走 `guard` 方法），从观察读 `guard` 状态。租约丢失、重新接管后不自动恢复（和“不重放”的原则一致），由驱动器提示模型。
- `CompanionMode`：`Intent` 去掉 `guard`；`guardFor`、`noteGuard`、`lastGuard`、`fight` 移到 `GuardDuty`。
  - `follow` 的 `guard` 参数保留，含义变成“开始跟随时顺便打开保护”（默认开，沿用 WebUI 的默认值）。
  - `companion-mode guard` 不再要求正在跟随：没在跟随时要带 `player`（等待、做任务时也能开），在跟随时默认保护跟随的玩家。
  - `companion-mode stop` 结束跟随或等待时同时关掉保护（6.1）。
- `guard` 事件（开打、打完、撤退、躲苦力怕）改由 `RuntimeMonitor` 每次观察时根据 `guard` 状态生成，规则不变（开打 20 秒内只报一次，距离变化和每一下挥击不唤醒模型）。
- `SurvivalReflexes`：
  - `guarding()` 改成“保护开着且 `covering`”；覆盖时 3 格近身自卫不插手，不覆盖时照常自卫。
  - `ordinaryBusy` 把“保护正在打”算作忙：普通进食等打完；紧急进食照旧抢占（服务端在原生使用物品时不接管身体，所以吃完保护再接上）。
- 工具说明和提示词：`companion-mode` 的说明、`scripts/agents/game-instructions.mjs` 的保护规则改成“保护是独立开关，跟随、等待、做事时都有效”；不新增工具名，Codex 白名单不用改。
- WebUI：状态栏把保护单独显示（保护谁、是否覆盖、在不在打），不再挂在陪伴模式下面。

### 5.4 测试

离线：

- Java：`GuardDuty` 用假视图测（空闲时接管；任务中可打断时挂起任务、打完恢复、期限顺延；不可打断时等待；超出交战范围不接管；玩家离开、回来；`stop` 后保护还在、`revoke`／`claim`／`bodyChanged` 后清掉）；`ControlSessionTest` 补 `guard` 方法的租约校验和操作预算不变；`FollowCompanionTest` 补“职责层保护同一玩家时 follow 不再自己打”。
- 运行端：没跟随时 `companion-mode guard` 带 player 能开；跟随让开去做 `build` 时保护状态不变；`stop-action` 和 `companion-mode stop` 都关掉保护，任务的普通取消不关（6.1）；近身自卫在覆盖时不插手、不覆盖时照常；采集任务按 `busyMs` 顺延期限。

隔离服实测（新脚本 `scripts/server-guard-duty-smoke.mjs`，用协议测试玩家当被保护的人）：

1. 等待中，测试玩家身边刷僵尸 → Bot 过去打，打完回到原地附近。
2. 建筑进行中（地面层）刷僵尸 → Bot 停下去打，打完接着盖，最后放对的格数和不打断时一致，没有 `TIMEOUT`。
3. 建筑在垫脚柱上时刷僵尸 → 不下柱，先做完这根柱，下来后再打。
4. 合成界面开着时刷僵尸 → 做完合成、关界面后再打。
5. 测试玩家走到 20 格外 → `covering:false`，Bot 只自卫。
6. `stop` 后保护还在；`revoke` 后保护清掉。

之后请用户在真实模型试玩里验收“帮我砍树，同时保护我”。

### 5.5 风险

- 打断建筑、种地时，身体被带离原位，任务恢复后的重新寻路是否稳定，要看实测；先只放开地面层，柱上和屋顶不打断。
- 打架时长顺延可能让一个任务拖得很久；期限顺延设上限（例如原期限的 2 倍），超过照常 `TIMEOUT`，模型可再调一次续做。
- 过渡期新旧两条保护路径并存，测试要覆盖“旧运行端＋新服务端”。

## 6. 用户的决定（2026-10-10）

1. **保护什么时候结束**：明确关掉（`companion-mode guard false`、玩家说不用保护）、**不跟了（`companion-mode stop`）**、紧急停止、撤销控制时结束；任务中途的普通取消不关保护；玩家下线、走远只是暂时不覆盖，回来接着保护。
   - 注意：现在玩家在聊天里说“停／等一下”走的是驱动器的硬停止，会撤销控制，保护也就跟着清掉。要等评审第 1 条（暂停、取消、紧急停止分开）做了，“普通叫停不关保护”才会真正成立。
   - 只在等待（`wait`）中开的保护，`companion-mode stop` 结束等待时也一起关。
2. **离玩家多远还去打**：Bot 离被保护玩家 16 格以内才放下手上的事去打；超出只靠 3 格近身自卫。
3. **打完回哪**：等待中打完回到开始打之前站的地方（在保护范围内）；跟随中打完接着跟；做任务时打完回到任务。
