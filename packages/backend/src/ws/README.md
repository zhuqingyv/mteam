# packages/backend/src/ws

Phase WS 的 WebSocket 通讯目录。本 README 先只覆盖 **W1-A · protocol.ts**；其余模块 (subscription-manager / gap-replayer / ws-handler / ws-broadcaster / user-session) 落地后在本文件追加节。

---

## W1-A · `protocol.ts` —— 上下行消息协议

### 这个模块是什么

前端 ↔ 后端 WebSocket 通道的**消息形状契约**。只有类型定义和一个运行时守卫 `isWsUpstream`，不含任何业务逻辑、不 import `bus/*` / `comm/*` / `db/*`，让 `ws-handler` / `ws-broadcaster` 靠 `import type` 吃同一份形状。

### 接口一览

```typescript
import type {
  WsUpstream,
  WsDownstream,
  SubscriptionScope,
  WsErrorCode,
  WsEventPayload,
} from './protocol.js';
import { isWsUpstream } from './protocol.js';
```

上行（前端 → 后端）四种 `op`：

| op | 必填 | 可选 | 用途 |
|----|------|------|------|
| `subscribe` | `scope` | `id`, `lastMsgId` | 订阅一个作用域；带 `lastMsgId` 触发 gap-replay |
| `unsubscribe` | `scope` | `id` | 撤销订阅 |
| `prompt` | `instanceId`, `text` | `requestId` | 给某个 driver 打一次 turn |
| `ping` | — | — | 心跳 |

下行（后端 → 前端）五种 `type`：`event` / `gap-replay` / `pong` / `ack` / `error`。

### 使用示例

```typescript
// 在 ws-handler 里解析上行
ws.on('message', (raw: string) => {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return ws.send(JSON.stringify({ type: 'error', code: 'bad_request', message: 'json parse' })); }

  if (!isWsUpstream(parsed)) {
    return ws.send(JSON.stringify({ type: 'error', code: 'bad_request', message: 'schema' }));
  }
  // 到这 parsed 已收窄为 WsUpstream，可直接 switch(parsed.op)
});
```

### 为什么上下行分不同的 discriminant key（`op` vs `type`）

- 上行用 `op`（operation，动作意图）— 读的人一眼看出"前端让后端做 X"。
- 下行用 `type`（event/gap-replay/pong/ack/error 是"事件/响应类型"，不是动作）。
- 分开两套字面量避免 switch 误写（不会把下行 type 塞进上行流程）。

### `requestId` 的用途

只有 `prompt` 值得带 requestId —— fire-and-forget 模型下，前端立刻收到 `ack{requestId}` 确认"后端收到了"，后续 driver 产出通过事件流自然推回。`subscribe` 本质是幂等状态变更，`ack` 不带 requestId 也能配对（按连接序）。

### `lastMsgId` 必须是 string 不是 number

- 底层 messages.id 是 `msg_<base36>` 字符串；数字 id 会在 SQLite 里被字符串化后比较，容易出错位。
- 守卫严格拒 number：前端若误传 `lastMsgId: 0` 也会被挡回。

### `isWsUpstream` 设计决策

- **拒多余字段**：后端当前忽略的字段未来可能启用（例如给 subscribe 加 `filter`），现在就拒可避免前端偷偷依赖未公开字段。
- **不 throw**：约定由调用方捕获返回 `error{code:'bad_request'}`，让连接保持（对齐 REGRESSION R1-6）。
- **instanceId 空串拒**：防止空串穿透到 driverRegistry 查询。
- 守卫只校验结构；越权校验（`user` scope id !== ctx.userId）不在本层，在 `ws-handler`。

### 边界

- `WsEventPayload = Record<string, unknown>`：协议层故意不把 bus 事件字段复制一份。W2-2 `ws-broadcaster` 从 `BusEvent` 剥 `source/correlationId` 后塞入 `event` 字段，保持协议层与 bus 解耦。
- `WsErrorCode` 枚举不穷尽业务语义：新错误类型加到联合前先评审，避免码值膨胀。

---

---

## W1-B · `subscription-manager.ts` —— per-connection 订阅状态

### 这个模块是什么

WS 连接的"订阅集合"表 + 纯函数 `match(connectionId, busEvent)`。`ws-broadcaster` 消费 bus 事件时靠它判断该事件是否应该推给某条连接。

纯数据结构，零运行时外部依赖（只 `import type` bus/types + 同目录 protocol）。不做越权校验、不做可见性过滤、不做 gap-replay —— 各有其主模块。

### 接口一览

```typescript
import { SubscriptionManager, type ClientSubscription } from './subscription-manager.js';

const mgr = new SubscriptionManager();
mgr.addConn(connectionId);
mgr.subscribe(connectionId, { scope: 'team', id: 'team_01' });
mgr.match(connectionId, busEvent);  // boolean
mgr.unsubscribe(connectionId, { scope: 'team', id: 'team_01' });
mgr.removeConn(connectionId);
mgr.list(connectionId);              // 调试
mgr.stats();                         // { conns, totalSubs }
```

### match 优先级表

规则自上而下短路；任一命中即 `true`，全部未命中 `false`。

| # | 订阅形态          | 命中条件                                                  | 反例（不命中）                       |
|---|-------------------|-----------------------------------------------------------|--------------------------------------|
| 1 | `global:`         | 任意 BusEvent                                             | —                                    |
| 2 | `instance:<id>`   | `event.instanceId === id` 或 `event.driverId === id`      | 其他 instance / 不带 instance 字段   |
| 3 | `team:<id>`       | `event.teamId === id`                                     | driver.* / cli.* 不带 teamId 的事件  |
| 4 | `user:<id>`       | `event.type ∈ comm.*` 且 `event.to === 'user:<id>'`       | 非 comm.* / from=user:<id> / to ≠ user |

### 设计要点

- **user 订阅只看 `to`，不看 `from`**：语义是"发给我"，`from` 由前端本地 echo，避免双推。
- **越权不管**：`user` scope id 不等于 ctx.userId 的拦截在 `ws-handler`，本模块收到啥存啥。
- **global 吞一切**：含 `from=inst_leak` 之类将来的反向诉求请走 `filter/visibility-filter`，不改 match 语义。
- **未 addConn 容忍**：`subscribe` / `unsubscribe` 静默 no-op，`match` 恒 false。防御式设计，因为 ws close 与事件到达并发。
- **id 去重**：重复 subscribe 同一 `(scope, id)` 只记一次。

详尽文档见 `subscription-manager.README.md`。

---

## W2-1 · `ws-handler.ts` —— 上行消息路由（业务胶水）

### 这个模块是什么

每条 WS 连接的 `on('message')` 主循环：`JSON.parse → isWsUpstream → switch(op) → 调子系统 → 回下行`。串 W1-A 协议 + W1-B 订阅表 + W1-C gap 补发 + DriverRegistry。

不负责：连接挂载（ws-upgrade）、bus 事件广播（W2-2 ws-broadcaster）、连接关闭清理（ws-upgrade 层调 `subscriptionManager.removeConn` + `userSession.unregister`）。

### 接口一览

```typescript
import { attachWsHandler } from './ws-handler.js';

attachWsHandler(ws, { connectionId, userId }, {
  subscriptionManager, driverRegistry, commRegistry,
  gapReplayDeps: { messageStore, maxItems: 200 },
});
```

### 路由表

| 上行 op | 正常下行 | 异常下行 |
|---------|---------|---------|
| `subscribe` | `gap-replay` (当 lastMsgId 有效) + `ack` | `error{forbidden}` (user 越权) |
| `unsubscribe` | `ack` | — |
| `prompt` | `ack{requestId}` (fire-and-forget) | `error{not_ready}` |
| `ping` | `pong{ts}` | — |
| bad JSON / schema 不合 | — | `error{bad_request}` |

### 关键决策

- **gap-replay 先于 ack**：前端据此区分"补发完成"与"订阅就绪"。
- **prompt 不 await**：ack 立即回；driver 产出走 bus 事件 `driver.thinking/text/turn_done`，由 W2-2 broadcaster 推回。
- **user 越权在本层拦截**：`scope='user' && id !== ctx.userId` 不进 subscription-manager，保持 W1-B 纯数据结构（R1-10）。
- **所有错误不断开连接**：bad json / schema / not_ready / forbidden 都只回 error 下行。
- **driver.prompt reject 静默吞**：driver 自己 emit `driver.error`，handler 不向连接重复报错。

详尽时序图、竞态分析、错误传播见 `ws-handler.README.md`。

---

## W2-2 · `ws-broadcaster.ts` —— 按订阅过滤的下行广播器

### 这个模块是什么

**业务胶水**。替代旧 `bus/subscribers/ws.subscriber.ts` 的全量广播，消费 `bus.events$` 的白名单事件，按 per-connection 订阅（`SubscriptionManager.match`）+ 可见性规则（`VisibilityFilter.canSee`）两道门，把事件封成 `WsEventDown` 下行。旧白名单 `WS_EVENT_TYPES` **保留**在 `bus/subscribers/ws.subscriber.ts`（phase-comm W2-H 守门测试依赖），本模块直接 import 用它，不重复定义。

### 接口

```typescript
import { WsBroadcaster, type WsLike, type BroadcasterConn } from './ws-broadcaster.js';

const b = new WsBroadcaster({ eventBus, subscriptionManager, visibilityFilter });
b.start();                                   // 幂等；挂 bus.events$ 订阅
b.addClient(connId, ws, { principal });      // ws-handler 握手成功后调
b.removeClient(connId);                      // ws close handler 里调
b.stop();                                    // 卸载 bus 订阅；保留 clients 表
```

`BroadcasterConn.principal` 用 `filter/types.ts` 的 `ActorPrincipal`（`user`/`agent`/`system`），由 ws-handler 按认证的 `userId` 构造。

### 时序图（bus 事件 → 推给 N 个连接）

```
 (emit 源)                 ws-broadcaster                SubscriptionManager   VisibilityFilter         clientA.ws   clientB.ws
    │  bus.emit(e)              │                             │                    │                       │            │
    │ ──────────────────────▶   │                             │                    │                       │            │
    │                           │ rx filter WS_EVENT_TYPES    │                    │                       │            │
    │                           │ id = extractEventId(e)      │                    │                       │            │
    │                           │ payload = toWsPayload(e)    │                    │                       │            │
    │                           │─ for each (connId, client): │                    │                       │            │
    │                           │    readyState === OPEN?     │                    │                       │            │
    │                           │    match(connId, e) ───────▶│                    │                       │            │
    │                           │    canSee(principal, e) ─────────────────────────▶│                       │            │
    │                           │    ws.send({type:'event', id, event: payload}) ──────────────────────────▶│            │
    │                           │    … 第二个 client          │                    │                       │            │
    │                           │    ws.send(...) ───────────────────────────────────────────────────────────────────────▶│
```

### 事件 → 下行 id 抽取表（`extractEventId`）

| 事件族 | id 来源 | 为什么 |
|--------|--------|--------|
| `comm.message_sent` / `comm.message_received` | `event.messageId` | 与 `messages.id` 一致，前端按它去重；gap-replay items 的 id 同源 |
| 任意带 `eventId` 字段的事件 | `event.eventId` | MILESTONE §5.6 方案：`makeBase` 接入 A 系列后，所有事件都带 UUID |
| 其它（当前 tree 上 makeBase 尚未改造） | `crypto.randomUUID()` | 兜底。单条事件的一次分发内对所有 client 保持一致（外层取一次后复用） |

> A 系列把 `bus/helpers.ts::makeBase` 改成强制注入 `eventId` 后，第 3 条兜底会几乎不再触发；届时 REGRESSION R1-7 "id 来源于 bus 事件 eventId"可在该事件进入本模块前就满足，本模块零改动。

### 竞态分析

1. **event 到达 vs 新 subscribe 到达**
   - `dispatch` 迭代 clients Map；迭代中若有新连接 `addClient`，不保证当条事件就能推到新连接 —— 这是**预期行为**，新连接应靠自己的 gap-replay 补第一条（见 W2-1 subscribe + lastMsgId）。
2. **event 到达 vs client 被 remove**
   - RxJS 同步派发，`dispatch` 在单微任务内跑完；外部 close 事件触发的 remove 只会影响下一条事件。已被 remove 的 ws.send 若仍跑到（迭代快照），写到已 close 的 ws 抛异常被 `sendSafe` 吞。
3. **bus 事件 vs VisibilityFilter 规则更新**
   - `createVisibilityFilter` 每次 `canSee` 直读 store，不缓存 → 规则 upsert 后**下一条事件立即生效**（对齐 REGRESSION R2-5）。
4. **多 client 推同一事件时的 id 一致性**
   - `extractEventId` 对同一 event 在 `dispatch` 外层调用一次，所有 client 共享同一个 id；兜底 UUID 也不会出现同事件多 id。

### 错误传播路径

| 故障点 | 表现 | 处理 | 最终状态 |
|--------|------|------|---------|
| `JSON.stringify(down)` 抛 | 下行消息里含循环引用 / 不可序列化字段 | `sendSafe` 捕获 → stderr warn → **跳过**本 client | 该条对该连接丢失；上游应保证 payload 可序列化 |
| `ws.send` 抛（broken pipe / ws closed） | 捕获 → stderr warn | 跳过；下条事件到达时 `readyState !== OPEN` 会更快短路 | ws-upgrade close handler 最终 `removeClient` |
| `subscriptionManager.match` 异常（理论不应发生） | 冒泡到 RxJS observer | EventBus.emit 外层 try-catch 吞 | 一次事件丢失；subscriber 仍 alive |
| `VisibilityFilter.canSee` 抛 | 同上 | 同上 | 同上 |

### 为什么白名单仍然要过一遍

- W2-H 守门测试断言 `WS_EVENT_TYPES.size === 34`（本期预计 +1 到 35，见 R6-5）防 bus 契约漂移。
- 白名单的语义从"全量推"演变成"候选集"：本模块先用白名单过滤，再用订阅/可见性过滤，双层不重复。

### 边界与注意

- **不**负责握手 / 鉴权 / 上行路由（W2-1 ws-handler 管）。
- **不**负责订阅记账（`SubscriptionManager` 管）。
- **不**负责 gap-replay（W1-C gap-replayer + W2-1 ws-handler 管）。
- `BroadcasterConn` 故意不 `import type` ws-handler 的 `ConnectionContext`，避免业务胶水互引；ws-handler 的 context 结构化兼容即可。
- 非 `ws.OPEN` 的连接不 send（避免对 `CONNECTING` / `CLOSING` 状态 send 引发底层 ws 库异常）。

---

## W2-3 · `user-session.ts` —— WS ↔ `comm.registry` 用户连接适配

### 这个模块是什么

**业务胶水**。把每条 WS 连接按 `user:<userId>` 注册到 `comm.registry`，让 agent 侧 `send_msg(to='user:u1')` 沿现有 `CommRouter` 路径走到 WS。配套产物 `comm/socket-shims.ts` 定义 `SocketShim`，让 WS 伪装成实现 `Connection` interface 的对象（A7 已把 `Connection` 收窄为 `{ write, destroyed, destroy }`）。

```
ws 连接成功
   │
   ├─ register(connectionId, userId, ws)
   │     ├─ new SocketShim(ws)               // 挂 ws.close/error → _dead=true
   │     └─ commRegistry.register('user:u1', shim)
   │           ^ 若同 user 已有连接：前任 shim.destroy()（多 tab 覆盖）
   │
   ... (运行时) agent send_msg → commRouter.dispatch → registry.getConnection('user:u1')
                                                             → shim.write(text) → ws.send(text)
   │
   └─ ws close / client disconnect
         ├─ unregister(connectionId)
         └─ 仅当 registry 上仍是"本连接的 shim"才 unregister（避免误删多 tab 后的新连接）
```

### 接口

```typescript
import { UserSessionTracker } from './user-session.js';
import { CommRegistry } from '../comm/registry.js';

const tracker = new UserSessionTracker({ commRegistry });
tracker.register('conn_123', 'u1', ws);        // WS 已握手完成后调
// ... 使用中
tracker.unregister('conn_123');                // ws close handler 里调
tracker.listActive();                          // 调试：列出所有 (connectionId, userId)
```

### 时序图（agent → user 消息落到浏览器）

```
agent driver                 comm.router                registry            SocketShim         ws (browser)
     │ send_msg(to=u1)            │                        │                    │                    │
     │ ───────────────▶           │                        │                    │                    │
     │                            │ parseAddress→local:u1  │                    │                    │
     │                            │ store.insert(env)      │                    │                    │
     │                            │ emit comm.message_sent │                    │                    │
     │                            │ getConnection('user:u1')                    │                    │
     │                            │ ────────────────────▶ │                    │                    │
     │                            │                        │ return shim        │                    │
     │                            │ shim.write(notifyLine) │                    │                    │
     │                            │ ─────────────────────────────────────────▶ │                    │
     │                            │                                             │ ws.send(text)      │
     │                            │                                             │ ─────────────────▶ │
     │                            │ emit comm.message_received (route=socket)   │                    │
```

非 comm 路径（`driver.text` 等）不经本模块，走 `ws-broadcaster` + `subscription-manager`（W2-2），保持本 README 只关注 comm 分支。

### 竞态分析

1. **同 userId 多 tab 注册**
   - A 先注册 → `registry['user:u1']` 指向 shim_A
   - B 后注册 → `CommRegistry.register` 内部 `prev.destroy()` → shim_A `_dead=true` 且 `wsA.close()`
   - 结果：registry 指向 shim_B；A 的浏览器收到 close；后续 A 的 close handler 调 `unregister('conn_A')`，读 registry 发现挂的是 shim_B，不动它（见"单连接注销保护"）。
   - **contract**：同一 userId 只有最新连接收到后续消息；旧连接上的消息由 gap-replay 在 A 下次上线补（R4-5）。

2. **register 与 unregister 并发**
   - `unregister` 查 `byConn`；若 connectionId 在 `register` 中途被移除，只影响本地表。
   - 已注册但尚未 ws-close 的连接若被外部再次 `register(connectionId, ...)`，内部先调 `unregister` 清理：这条链避免"旧 shim 漂在 registry"。

3. **ws close 事件丢失（移动端熄屏、进程 kill）**
   - 本期**不做**心跳超时清理；`SocketShim.destroyed` 依赖 `ws.readyState`/close/error 事件。若 OS 迟迟不 fire close，消息仍会 `send()` 成功（ws 内部 buffer），但下游客户端永远收不到。
   - **TODO（下期 R1-11）**：30s 心跳无响应 → 主动 `shim.destroy()`。本期上行已有 `ping` op（R1-3），但没有下行主动 ping，也没有清理定时器。arch-ws-b 审查同意。

### 错误传播路径

| 故障点 | 表现 | 处理 | 最终状态 |
|--------|------|------|---------|
| `ws.send` 抛异常（broken pipe / 已 close） | `SocketShim.write` 捕获 → `_dead=true` → 返回 `false` | router `conn && !conn.destroyed` 下次 false → 走 offline 分支 | envelope 已落库，上线 replay |
| 客户端主动 close | `ws` close 事件 → `SocketShim._dead=true` | 同上；配合外层 ws close handler 调 `unregister` | registry 清干净 |
| `unregister` 时发现 registry 上是别人的 shim（多 tab 覆盖） | 不动 registry，只 destroy 本连接自己的 shim | 保护新连接 | 新连接继续工作 |
| `register` 同 connectionId 二次调用 | 内部先 `unregister` 清理前任 | 幂等 | 只保留最新 ws |

### 设计决策

- **Shim 不碰 registry**：`SocketShim.close/error` 只置 `_dead`，不 `registry.unregister`。注销统一由 ws-upgrade 的 close handler 经 `tracker.unregister` 走唯一入口，避免"shim 自己注销 + handler 再注销"两路竞态。
- **address 格式 `user:<userId>`**：和 `subscription-manager.match` 对 `comm.* envelope.to === 'user:<id>'` 的判定一致；单用户场景上层传 `userId='local'` 即可。
- **Connection 要求 `Buffer | string`**：现 `Connection.write` 签名是 `(string | Buffer) → boolean`，shim 把 Buffer 转 utf8 再 `ws.send`。Why：server.ts (TCP) 路径全是 string，但 interface 保留 Buffer 兜底让 shim 不撒错。
- **越权校验不在本模块**：`userId` 由 ws-upgrade 从 query 解析并校验；本模块信任调用方。

### 边界与注意

- `UserSessionTracker` 单实例跨整个进程。多进程部署下需要上游 session registry（当前未规划）。
- `listActive` 是调试接口，返回拷贝不持外部引用。
- **不测的场景**：真实 ws npm 包的底层行为（握手失败 / TLS 错误等），由 ws-upgrade 的集成测试覆盖。本模块只测"shim ↔ registry ↔ tracker"三者的协作。

---

## 测试

```
cd packages/backend
bun test src/ws/protocol.test.ts
bun test src/ws/subscription-manager.test.ts
bun test src/ws/gap-replayer.test.ts
bun test src/ws/ws-handler.test.ts
bun test src/ws/ws-broadcaster.test.ts
bun test src/ws/user-session.test.ts
```

覆盖：
- `protocol.test.ts`：9 正例 + 16 反例 + 编译期判别断言
- `subscription-manager.test.ts`：19 用例 —— 连接生命周期幂等 / subscribe 去重 / 5 条 match 规则各 1 正 ≥1 反 / global 吞其他 / 连接隔离 / list 返回拷贝
- `gap-replayer.test.ts`：team/instance/user 三 scope + 超量翻页 + global 不支持 + 非业务防漂移
- `ws-handler.test.ts`：13 用例 —— subscribe (无/有 gap/越权) / unsubscribe / prompt (4 分支：不存在、未 READY、READY 成功、reject 不崩) / ping / bad json / schema / Buffer 上行 / commRegistry 不被触碰
- `ws-broadcaster.test.ts`：14 用例 —— team 订阅隔离 / global 收全 / instance 过滤 / deny 规则 drop / id 取 messageId/eventId/UUID 三路径 / source-correlationId 剥离 / CLOSED 跳过 / send 异常隔离 / removeClient / stop 停推 / 白名单外事件被挡 / start 幂等
- `user-session.test.ts`：9 用例 —— register/unregister 基础 / write 转发 / 多 tab 覆盖前者 destroyed / 旧连接 unregister 不影响新连接 / ws close 事件 / send 抛异常降级 / register 幂等
