# mcbot-kaleidoscope-cookery

MCBOT 的示例附属模组：让 Bot 用[森罗厨房（Kaleidoscope Cookery）](https://modrinth.com/mod/kaleidoscope-cookery)的炒锅做菜。这也是一个参考：怎么用 [Mod 适配接口](../../docs/mod_adapters.md)，给一个大型 Mod 写附属模组。

- **只支持** Kaleidoscope Cookery `1.6.0-neoforge+mc1.21.1`。版本不对时，这几个交互会报告"没安装"，Bot 不会去用。
- 用反射读取炒锅状态，编译时不依赖森罗厨房。模组里不带森罗厨房的任何代码和素材（森罗厨房的代码是 BSD-3，素材是 CC BY-NC-SA 4.0）。本附属模组用 Apache-2.0。
- 服务器上同时装：`mcbot-server-control`、`kaleidoscopecookery`、本模组。单人世界也一样，装在客户端的 mods 里。

## 交互

都是对 `kaleidoscope_cookery:pot` 的右键，AI 通过 `interact-block` 调用：

| 交互 | 手持 | 什么时候能用 | 效果 |
| --- | --- | --- | --- |
| `kaleidoscope_cookery:pot/add_oil` | 油（`#kaleidoscope_cookery:oil`） | 空锅、下面有热源、还没放油 | 消耗 1 个油，锅里有油 |
| `kaleidoscope_cookery:pot/add_ingredient` | 普通食材 | 已放油、还没开始翻炒、锅没满 | 消耗 1 个，锅里多一样食材 |
| `kaleidoscope_cookery:pot/stir` | 锅铲（`#kaleidoscope_cookery:kitchen_shovel`） | 锅里有食材，或正在炒且还要翻 | 第一下开始炒，之后每下减 1 次翻炒；锅铲可能掉耐久 |
| `kaleidoscope_cookery:pot/take_out` | 这道菜的盛具（比如碗） | 炒好了（没糊） | 用掉盛具，拿到菜，锅变回空锅 |

- 不满足条件时，交互在右键前就会被拒绝（`INTERACTION_NOT_READY`），并说明原因。例如："先放油""还在炒，剩 6 秒""拿着碗才能出锅"。
- 每次回执里带着炒锅的状态（`summary`），包括：阶段、锅里的食材、还要翻几次、剩几秒、会出什么菜、用什么盛。AI 按这些决定下一步。
- **翻炒由程序盯**：菜谱要求在限定时间里翻够次数（默认 10 秒、3 次）。AI 只需调用一次：

  ```json
  { "interaction": "kaleidoscope_cookery:pot/stir", "item": "kaleidoscope_cookery:kitchen_shovel",
    "repeatUntil": { "field": "stirsLeft", "equals": 0 } }
  ```

  运行端会连续翻炒，直到剩余次数为 0。中途有一次没成功就停下，不会重复。

- **暂不支持**：
  - 炒糊后取出黑暗料理
  - 不用盛具、要潜行加锅铲才能出锅的菜（比如牛皮糖）
  - 会退回容器的食材（比如牛奶桶）
  - 带油的锅铲和油壶

## 构建和测试

```pwsh
cd mods/mcbot-server-control; ./gradlew.bat build      # 先构建核心，它的 jar 提供 MCBOT API
cd ../mcbot-kaleidoscope-cookery; ./gradlew.bat build   # 含离线测试 PotRulesTest
```

隔离服实测用 `scripts/server-cooking-smoke.mjs`：用糖醋里脊走一遍完整流程，从放油、加料、翻炒到出锅。
