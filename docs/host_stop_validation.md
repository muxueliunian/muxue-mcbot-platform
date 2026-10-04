# 宿主叫停识别修复与离线验收

日期：2026-10-04。范围仅为普通聊天误触发宿主硬停止；从最新 `main` 创建 `codex/fix-addressed-stop`，不直接修改或合并 `main`。当前主线仍为本机 Agent → MCP／任务层 → ServerBody，完整能力集保持39工具。

## 问题与修复边界

原 `scripts/companion.mjs` 的 `isAddressedStop` 在正文任意位置发现 Bot 名称后，只要再出现“停”等子串就返回 true；同时无条件剥离首个冒号前缀，且把问号当作可忽略的结尾标点。真实游戏历史记录中的描述性聊天误停，已在本轮离线复现。

本次仅替换该识别函数，不调用模型判断紧急停止，不改 `server-body-control.mjs`、共享写锁、租约、控制代次、操作回执、unknown不自动重试、旧任务废弃或宿主独立撤销机制。描述性消息仍走既有聊天路径；这里保证的是“不被宿主凭关键词直接revoke”，不宣称替模型理解所有自然语言。

## 支持的有限语法

正文先去首尾空白，英文不区分大小写，然后整句匹配：

| 类别 | 支持范围 |
| --- | --- |
| 独立命令 | `停`、`停下`、`停止`、`别挖`、`别建`、`等一下`、`等等`、`stop`；也明确支持 `别挖了`、`别建了` |
| 明确点名 | 正文开头为当前配置的完整 `name` 或 `nickname`，之后接上述命令；另外保留明确点名的 `暂停` |
| 称呼后的分隔 | 可直接接中文命令，或使用空格、制表符、`,`、`，`、`:`、`：`、`!`、`！` |
| 命令后的标点 | 只允许空格、制表符、`!`、`！`、`。`、`.`、`,`、`，` |
| 不扩大解释 | 问号、引号、括号、否定、描述、疑问及额外句子不被删除；不做任意子串命中。`Codexstop`、`CodexBot2 stop`不算对Codex的点名 |

例如，小克应接受 `停下！`、`小克，停下`、`小克别挖了`；Codex应接受 `Codex stop!`。当前Bot称呼不是Codex时，`Codex stop!`不能触发当前Bot的硬停止。

以下五句均不得仅凭关键词叫停：

```text
小克，修改策略会停止全部当前任务
小克，别停，继续跟随
小克，你停在哪里？
小克，停止以后还能继续吗？
小克，刚才他说‘停下’
```

`停下？`、`stop?`、`“停下”`、`小克，说：停下`、`小双，停下`、`Gemini: stop!`也不对小克触发硬停止。未列入语法的更复杂说法仍由正常聊天路径处理；需要宿主立即叫停时使用上述明确命令。

## 消息正文、发言者与称呼

1. 有 `message` 字段时，它是权威正文。空正文或非字符串不从 `text` 补出命令，正文内的冒号不再被当成发言者分隔符。
2. 只有 `text`、但有 `username` 时，仅移除与该发言者完全相同的首个前缀。
3. 兼容现有 `EventJournal`：有非空 `session` 和正整数 `seq`，且无已知发言者时，仅移除一次 `Java用户名: 正文` 形式的前缀；用户名为1–16位ASCII字母、数字或下划线，冒号后须有空格或制表符。当前生产者见 `client-runtime/src/events.ts`。
4. 没有上述信封元数据的 `text` 被视为正文，不能猜测 `其他Bot: stop!` 中冒号前的名字是发言者。发言者名字不计入正文点名；单独的“停下”仍是独立命令。

既有 `codex-adapter.test.mjs` 中六个带发言者显示前缀的夹具补齐 `username`，保留原断言；没有删除或放宽测试。新矩阵同时覆盖结构化事件和真实旧journal格式的 `chat`／`whisper`。

## 本轮实际执行结果

环境：Linux、Node v22.16.0。GitHub直连克隆不可用，通过连接器读取所需原文件，在隔离目录重建相关宿主、协议及测试文件；这不是完整仓库构建。所有集成测试使用真实 `companion.mjs` 子进程、仓库现有Claude/Codex协议替身及loopback模拟v2服务，不使用真实模型账号、不启动Minecraft。

| 执行 | 本轮结果 |
| --- | --- |
| 原实现＋新增 `host-stop.test.mjs` | 278项：175通过、103失败，退出码1；保留先红记录 |
| 修复后，同一新增文件 | 278／278通过，退出码0 |
| 既有宿主／协议的可执行子集 | 21项通过，退出码0；两项明确排除，见下文 |
| 最终四文件组合复跑 | 299项通过、0失败，退出码0；耗时约26.45秒，与前两组重叠，不能相加当成更多独立用例 |
| 语法检查 | `scripts/companion.mjs`、新增测试文件均通过 `node --check` |

新增四组真实宿主子进程回归覆盖 Claude／Codex × 独立watch／journal。Agent保持在未完成的忙回合时，逐一加入五句描述性消息，确认没有revoke或结束Agent；再加入真正叫停，确认不等待模型完成就撤销。watch路径还核对journal实际字节未改变。停止前排队的旧任务和普通聊天不重放；停止确认后的第一条新任务在反复watch下仅交付一次。另有真实分类器＋控制通道回归，确认旧watch返回的停止消息不能撤销已经替换的新租约。

最终实际执行命令（仓库根目录，Linux shell）：

```sh
node --check scripts/companion.mjs
node --check mcp-server/tests/host-stop.test.mjs
node --test --test-timeout=90000 \
  --test-skip-pattern='start-server-play PrepareOnly|Codex 配置不回写 null 字段' \
  mcp-server/tests/host-stop.test.mjs \
  mcp-server/tests/server-driver.test.mjs \
  mcp-server/tests/agent-protocols.test.mjs \
  mcp-server/tests/codex-adapter.test.mjs
```

**执行失败与排除项不抹去：** 曾用 `--test-name-pattern='^(?!start-server-play PrepareOnly)'` 试图排除PowerShell检查，但本环境中没有达到预期。该次 `server-driver.test.mjs` 实际12项，11通过、1失败；失败为 `start-server-play PrepareOnly` 尝试启动不存在的 `pwsh`，子进程status为null。随后改用上述明确的 `--test-skip-pattern`。最终Node输出只统计被选中执行的299项，不能把输出的 `skipped 0` 解释为没有排除用例。

本轮未执行的两项为：`start-server-play PrepareOnly读取v2身份和显式Node路径但不运行Agent且不写token`（无pwsh），以及 `Codex 配置不回写 null 字段；只开放真实注册的 V0 游戏工具`（选择性镜像未包含完整旧工具源码目录）。没有为通过测试伪造该目录，也没有删除这些用例。未运行完整npm构建／全量依赖测试、Java测试、Windows进程树与启动器检查、真实模型和游戏复验。

## 待本机复验

在已有完整检出、Node和PowerShell 7环境中，用pwsh执行以下离线回归，不使用真实模型账号：

```powershell
node --test --test-timeout=90000 mcp-server/tests/host-stop.test.mjs mcp-server/tests/server-driver.test.mjs mcp-server/tests/agent-protocols.test.mjs mcp-server/tests/codex-adapter.test.mjs
```

随后在另行准备、授权的隔离游戏环境中核对真实chat／whisper投影和四个正例、五个反例，确认忙时叫停、停止后首个新任务、旧任务不重放及角色保持在线；分别记录Claude/Codex结果。此项本PR未执行，不要求为了提交PR启动Minecraft。

## 历史证据与后续交接

`server_navigation_defense_validation.md` 的30分3.947秒连续运行记录中，有一项生命值核对无效；修正后的19阶段、204.085秒聊天短复验是另一轮。两者均为历史证据，不能冒充本轮执行，也不能合称“无缺口30分钟通过”。既有Windows Node24.15原生退出未因本轮Linux通过而关闭；历史失败记录保持不变。

下一批先做R8：已验证空槽的整栈转移优化、容器任务总期限，保留回执核验及去重保护；随后少量原版矿石的有限采集，并安排自然地形与Codex新增生存能力实测；持续陪挖和最小建筑预设分别交付，旧建筑设计资料可复用但执行器须迁移。本PR不实现这些后续能力。

交接继续使用中文；Windows使用pwsh，云端使用实际支持环境。保留已有修改，不改根规则、人设或提交凭据。非必要禁止计算或校验任何哈希／指纹，普通比较直接核对实际字节或字段；此约束不得从后续交接中省略。
