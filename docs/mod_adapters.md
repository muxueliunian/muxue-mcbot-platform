# Mod 适配接口（R5）

Bot 默认只会用原版的箱子、木桶、漏斗、发射器、潜影盒、熔炉，以及登记过的右键交互。其他 Mod 的方块要靠适配器才能用。没有适配的方块，Bot 一律拒绝操作，不会去猜。

适配有两种办法：

| | JSON 声明 | Java 附属模组 |
| --- | --- | --- |
| 适合 | "拿着这些物品、右键这些方块，可能产生这些变化"这类简单交互 | 容器和机器的菜单、对空使用物品、需要读方块内部状态或自己校验结果的交互、把掉落物直接收走的 Mod |
| 谁来写 | 服主，不用写代码 | Mod 作者或适配者，单独打包成一个附属模组 |
| 放在哪 | `config/mcbot-server-control/interactions/*.json` | 和 mcbot-server-control 一起放进 `mods/` |

两种都在服务器启动时加载。之后服务端会把它们告诉运行端：容器适配列在 `hello.adapters`，交互列在 `hello.interactions`，其中对空使用的交互另外列在 `hello.itemInteractions`。AI 在 `open-container`、`interact-block` 和 `use-item` 的工具说明里能看到这些名单。启动日志里会打一行 `MCBOT adapters: ...`。有问题的 JSON 文件和适配器会被跳过，并记一条 `MCBOT adapter: ...` 警告。

## 安全规则

所有适配都遵守下面几条：

- **版本锁定**：只在验证过的确切版本上启用。版本对不上就当作没装。JSON 的 `requires` 和 Java 的 `McbotApi.versionsMatch` 都要求版本号完全一致，Minecraft 和 NeoForge 也必须是 1.21.1 / 21.1.217。
- **原版容器不能被接管**：原版的容器方块和菜单走内置规则，适配器不能声明它们。
- **出错就拒绝**：适配器的方法抛异常，就当作"不匹配"。如果异常发生在右键之前，就拒绝这次操作；如果发生在右键之后，回执记为 `unknown`。不会因为适配器出错而当作成功。
- **按声明判结果**：右键交互前后会各拍一次快照，包括方块、Bot 的背包、打开的菜单和附近掉落物。
  - 所有变化都在声明范围内：`succeeded`。
  - 什么都没变：`failed`。
  - 其余情况：`unknown`，AI 被要求先重新观察，不要重放。
- **id 不能重复**：容器、交互和拾取适配的 id 共用一个命名空间。先登记的优先，顺序是内置 → JSON → 附属模组，重复的会被跳过并记日志；附属模组之间重复登记，会在模组加载时直接报错。
- **登记有截止时间**：服务器启动后，附属模组就不能再登记了。

## JSON 声明

每个文件写一个对象，或一个对象数组。只要有一条写错，整个文件都会被跳过。不认识的键也算写错。

```json
{
  "id": "minecraft:respawn_anchor/charge",
  "note": "给重生锚充能；满能量时右键会在主世界爆炸，所以 charges=4 时拒绝",
  "blocks": ["minecraft:respawn_anchor"],
  "held": ["minecraft:glowstone"],
  "consume": [1, 1],
  "changes": ["charges"],
  "refuseWhen": { "charges": ["4"] }
}
```

| 键 | 必填 | 含义 |
| --- | --- | --- |
| `id` | 是 | 交互名，AI 调用时用它。命名空间不是 `minecraft` 时，这个命名空间必须写进 `requires` |
| `requires` | 非原版必填 | `{ "模组id": "确切版本" }` |
| `blocks` | 是 | 能右键的方块 id 列表 |
| `held` | 二选一 | 手持物品的 id，或 `#标签`。和 `emptyHand` 只能选一个 |
| `emptyHand` | 二选一 | `true` 表示必须空手；空手时不能消耗物品 |
| `consume` | 是 | `[最少, 最多]`，每次消耗多少个手持物品（0～64） |
| `heldDamage` | 否 | 手持工具允不允许掉耐久，默认不允许 |
| `changes` | 否 | 允许变化的方块状态名，比如 `level`、`charges` |
| `gains` | 否 | 允许新出现在背包或掉在地上的物品 id |
| `refuseWhen` | 否 | `{ "状态名": ["值", ...] }`：方块处于这些状态时直接拒绝，不右键。方块没有这个状态也拒绝 |
| `note` | 否 | 写给人看的说明 |

什么效果都不声明的交互（不消耗、不变状态、不得物品、不掉耐久）永远不会成功，所以直接拒绝加载。会把方块换成另一种方块的交互（比如往炼药锅倒水，炼药锅会变成另一种方块），JSON 表达不了，要用 Java 适配。

## Java 附属模组

公开接口都在 `com.mcbot.servercontrol.api` 包里：

- `McbotApi`：负责登记（`registerContainer`、`registerInteraction`），提供版本检查（`modVersion`、`versionsMatch`），以及拒绝时用的 `refuse(code, message)`。拒绝码只能是 `INTERACTION_NOT_READY` 或 `UNSUPPORTED`，写别的码会按 `INTERACTION_NOT_READY` 处理。
- `ContainerAdapter`：用来接管容器和机器，要实现这些方法：
  - 识别方块（`block`），核对方块实体（`entity`）
  - 在方块自己不提供菜单时给出菜单（`provider`）
  - 识别菜单（`menu`）
  - 核对完整的槽位布局后，返回真正的存储（`storage`）
  - 给间接包装的玩家槽报出对应的背包位置（`playerSlot`）
  - 物品处理器（item handler）型的存储：槽位的 `Slot.container` 只是占位，`storage` 返回一个代表这份存储的只读对象，再用 `storageSlot` 认领它的槽，用 `storageOf` 说明它属于哪个方块实体（`discover-containers` 的目标核对要用）。例子见 SB 附属模组的 `BackpackContainerAdapter`

  Bot 只操作归属清楚的槽：`storage` 里的算容器槽，玩家背包里的算玩家槽。其余的槽标成 `unknown`，Bot 不会去点。
- `ItemInteraction`：右键交互。除了 JSON 能表达的内容，还可以：
  - 用 `summary` 读方块内部状态，比如锅里有什么
  - 用 `expectedFor(右键前的 summary)` 按当时的状态给出预期效果，比如出锅时会得到哪道菜
  - 用 `consistent` 核对前后两次快照的值。参数是完整快照，包含 `summary`、`block`、`inventory`、`menu`、`drops`
  - 用 `precondition` 在右键前检查
  - 用 `menu` 核对打开的菜单

  回执会把 `summary` 带给 AI。对时间敏感、需要连续右键的步骤（比如炒锅翻炒），AI 可以给 `interact-block` 传 `repeatUntil`，运行端会连续右键，直到 `summary` 里某个字段达到目标值。

  `kind` 为 `item` 时是对空使用物品，比如打开背包，AI 用 `use-item` 调用。手上物品会被 Mod 改写的（比如背包第一次打开时写上存储 ID），在 `Expected` 的 `heldComponents` 里列出允许变化的组件名，再在 `consistent` 里核对具体的值。
- `PickupSink`：有些 Mod 会在原版拾取之前把掉落物直接收进玩家身上的存储，并取消原版拾取（比如背包的拾取升级），这时没有原版的拾取事件。MCBOT 在拾取前后各调用一次 `stored`，读出这类存储里每种物品的数量。只有"被吃掉的那种物品在某一个存储里正好多了吃掉的数量，其他都没变"时，才把这次拾取记下来，回执里用 `storedIn` 写明去处。对不上就记为 `PICKUP_UNKNOWN`，并在拾取收据里留一个缺口。用 `McbotApi.registerPickupSink` 登记。

- `WorkstationAdapter`（`api.workstation` 包，10-07 新增，[设计](workstation_design.md)）：工作站。适配者只说明是哪个方块和界面、哪个格子是什么端口（原料、燃料、成品等）、配方从哪来、用哪种执行模板（`GRID_CRAFTER` 合成网格、`PROCESSOR` 放料→等→取的机器；另有 `OPTION_PICKER`、`IN_PLACE`、`MODIFIER`，目前只有原版切石机、酿造台、附魔台等内置适配在用，附属模组登记这三种还不会被 produce-item／modify-item 选中）；走过去、开界面、点格子、等待和核对都由核心做。登记后 `craft-item`、`smelt-item` 会自动用上。原版方块只由内置适配处理，附属模组不能接管。用 `McbotApi.registerWorkstation` 登记。这个包只用原版和 JDK 类型，以后的 Fabric 版也用同一套接口。

在附属模组的构造函数里登记：

```java
@Mod("mcbot_examplecook")
public final class McbotExampleCook {
    public McbotExampleCook() {
        McbotApi.registerInteraction(new PotAddOil());   // 实现 ItemInteraction，installed() 里用 McbotApi.versionsMatch("examplecook", "1.2.3")
    }
}
```

附属模组的 `neoforge.mods.toml` 要声明依赖 `mcbot_server_control`，同时也依赖被适配的模组（可以设为可选，被适配的模组没装时，`installed()` 返回 false 就行）。编译时只需要 mcbot-server-control 的 jar（`compileOnly`）。被适配的模组建议用反射访问，不在编译期依赖它：Mod 改了类名或方法，适配器只会认不出来，不会让服务器崩溃。

参考例子：

- 内置的 Iron Furnaces 适配（`IronFurnaceAdapter`）：一个完整的 `ContainerAdapter`，用反射访问 Iron Furnaces，锁定 4.3.2 版。
- [mcbot-kaleidoscope-cookery](../mods/mcbot-kaleidoscope-cookery/README.md)：独立的附属模组。用森罗厨房的炒锅做菜，包括放油、加料、翻炒、出锅四个交互。
- [mcbot-sophisticated-backpacks](../mods/mcbot-sophisticated-backpacks/README.md)：独立的附属模组。打开手里的背包（对空使用）、把放在地上的背包当容器（物品处理器型存储）、拾取升级的记账（`PickupSink`）。

## 测试

- 离线：`ModAdaptersTest`（登记、合并、出错时的处理、JSON 格式）、`ItemInteractionsTest`、`IronFurnaceAdapterTest`。
- 隔离服：`scripts/server-adapter-smoke.mjs`。测试服要临时装上 Iron Furnaces 4.3.2，并在 `interactions/` 里放一份正确的重生锚声明和一份故意写错的声明。
- 示例附属模组：`scripts/server-cooking-smoke.mjs`（森罗厨房）、`scripts/server-backpack-smoke.mjs`（SB，开服前先运行 `scripts/server-backpack-fixture.mjs`）。

## 和其他 Mod 一起用时要注意

- 有的 Mod 会在玩家登录时给客户端发自己的网络包。Bot 没有客户端，核心会直接丢掉发给 Bot 的包，不做"客户端有没有这个频道"的检查（否则 Bot 登录会失败）。
- 像 SB 这样要求客户端也装的 Mod，没装的玩家（包括用原版协议的测试玩家）进不了服。
- 方块的 `open` 属性（木桶、背包被人打开时会变）不算目标变化，核对 `discover-containers` 的目标时会忽略它。
