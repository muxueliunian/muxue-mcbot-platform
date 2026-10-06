# ClientBody 原型协议 v1

这是 V1 实现使用的最小契约，不代表游戏验收。TS 公共类型不引用 Mineflayer 或 Minecraft Java 类型；MC／加载器相关实现放在客户端 Mod 内。

## 本机通道

客户端 Mod 只在 `127.0.0.1` 监听 HTTP（默认 8765，可由 JVM 属性 `mcbot.control.port` 修改）。启动生成随机 token，保存到实例 `config/mcbot-control/connection.json`：`{protocol:1,endpoint:"http://127.0.0.1:8765/v1",token:"..."}`。凭据不进入源码或日志。控制器读取该文件，拒绝非 loopback endpoint，禁用重定向。

请求：`POST /v1`，`Content-Type: application/json`，`Authorization: Bearer <token>`，JSON `{method,params}`。拒绝浏览器 Origin 和超过 64 KiB 的输入。应答 `{ok:true,result}` 或 `{ok:false,error:{code,message}}`；游戏操作结果中的失败另以 operation.status 表达。MC 状态读取／动作只在游戏主线程执行。持续动作由 tick 推进，HTTP 请求不能阻塞游戏线程。

## 控制权和世界

- `hello {}` → `{protocol:1,platform:{minecraft,loader,loaderVersion},capabilities:string[],connected,username,sessionId}`。
- `claim {controllerId,username,worldId}` → `{leaseId,ttlMs:10000}`。同一时间只允许一个控制者；实际玩家名须匹配 username，连接世界后才可 claim。worldId 是用户明确选择的资料标识，不能推测服务器身份。
- `heartbeat {leaseId}` → `{ttlMs:10000}`，控制器每 2 秒续租。其他请求不延长租约。
- `release {leaseId}` → `{released:true}`；取消动作并释放按键，保持客户端在线。
- `stop {leaseId}` → `{stopped:true}`；取消全部活动动作并释放按键，不退出、不转交模型处理。
- 租约超时、客户端退出世界、维度／玩家实例变化、死亡均取消动作与租约。新的世界代次使用新的 sessionId；旧 sessionId、operationId、菜单句柄不可重用。暂时没有世界时 sessionId 为 null。

## 观察

`observe {leaseId,block?:{x,y,z}}` → 客户端当前观察快照（可能包括本地预测，不等同于服务端确认）：

```text
{sessionId,worldId,connected,username,dimension,health,food,
 position:{x,y,z},yaw,pitch,
 inventory:[{slot,id,count}],
 entities:[{id:string,type,name,position:{x,y,z}}],
 chat:[{seq,time,username?:string,message:string}],chatCursor:number,
 container:null|{id:string,type,slots:[{slot,id,count}],carried:{id,count}},
 block?:{position:{x,y,z},state:"loaded"|"unloaded",id?:string,properties?:object},
 source:"client-observed"}
```

坐标为 MC 世界坐标；yaw/pitch 使用角度。物品／方块／实体 type 均使用命名空间 ID。实体限 32 格内 64 个，聊天为最近 100 条；空气为 `minecraft:air`，未加载不冒充空气。菜单 id 包含 sessionId 和打开代次，不允许旧窗口槽位误投到新窗口。服务端插件聊天若无法可靠解析玩家名，保留原文、不猜测身份。

## 执行

`act {leaseId,sessionId,operationId,name,args}` → operation。operationId 由控制器生成随机 UUID。同代次同 ID 同参数返回原操作，参数不同拒绝；直接比较规范化 JSON 字段，不计算哈希。客户端保留有限操作记录，淘汰后旧 ID 不可自动重发。

`operation {leaseId,sessionId,operationId}` → `{operationId,sessionId,name,status,summary,result?}`。status 为 `running|succeeded|failed|cancelled|unknown`。请求超时属于结果未知，控制器不能自动重发变更命令。`running` 不当作完成；客户端预测和“已发包”也不能冒充服务器确认。

首批动作名称及参数：

| name | args | 语义 |
| --- | --- | --- |
| send-chat | `{message}` | 正常发送聊天，不提供 OP/RCON，不发送以 `/` 开头的命令；成功只代表交给客户端连接 |
| look-at | `{x,y,z}` | 转向目标 |
| move-to-position | `{x,y,z,tolerance?:number,timeoutMs?:number}` | 有限距离正常移动；遇障碍／危险／超时失败，不传送，不擅自挖路 |
| follow-player | `{player,distance?:number,timeoutMs?:number}` | 有期限跟随已同步玩家；停止前为 running |
| dig-block | `{x,y,z,expectedBlock:string,timeoutMs?:number}` | 只挖明确授权一格；执行前核对目标 ID、触及距离、视线，变化后复查 |
| place-block | `{x,y,z,face:"up"|"down"|"north"|"south"|"east"|"west",slot:number,expectedItem:string,expectedBlock:string,timeoutMs?:number}` | x/y/z 为所点击的支撑格；核对支撑 ID、背包物品、触及距离、目标占用；使用普通玩家交互 |
| open-container | `{x,y,z,expectedBlock:string,timeoutMs?:number}` | 普通右键并等待菜单打开 |
| click-slot | `{containerId:string,slot:number,expectedItem:string,expectedCount:number,expectedCarriedItem:string,expectedCarriedCount:number,button?:0|1}` | 普通 PICKUP 点击一个槽位；核对窗口、槽位和鼠标携带栈（空为 minecraft:air／0）；返回操作后观测，不能将预测当成功 |
| close-container | `{containerId:string}` | 关闭当前匹配菜单 |

一个独占持续身体动作通道；新身体动作遇忙返回 BUSY，用户可先 stop。聊天和观察可并行。停止取消已有动作；新的明确命令用新 operationId。挖放／容器应等待服务端同步确认；若绑定无法可靠区分预测，则返回 unknown 与观测，不谎报 succeeded。

## 首轮实现边界

基本移动不等于完整寻路；协议能力清单只声明实际实现的动作。V1 先发布可编译、可离线验证的增量，独立客户端安装和游戏验证另行记录。运行端使用独立 `client-runtime` 包，只依赖 MCP SDK／参数校验库，旧 Mineflayer 入口保持可用。
