# ws/ws-handler (W2-1)

**一句话：** 每条 WS 连接的上行消息主循环 —— 解析、守卫、路由到 subscription-manager / gap-replayer / driverRegistry，并回相应下行。

业务胶水，串 W1-A 协议 + W1-B 订阅状态 + W1-C gap 补发 + agent-driver 注册表。不负责连接挂载（ws-upgrade）、不负责 bus 事件广播（W2-2 ws-broadcaster）、不负责连接关闭清理（ws-upgrade 那层调 `subscriptionManager.removeConn` + `commRegistry.unregister`）。

---

## 接口

```typescript
import { attachWsHandler, type ConnectionContext, type WsHandlerDeps } from './ws-handler.js';

attachWsHandler(ws, { connectionId, userId }, {
  subscriptionManager,
  driverRegistry,
  commRegistry,    // 本 handler 不直接调用，保留给未来 W2 胶水复用 context
  gapReplayDeps: { messageStore, maxItems: 200 },
});
```

上行 `op` 与下行 `type` 对应表（详见 `protocol.ts`）：

| 上行 op | 正常下行 | 异常下行 |
|---------|---------|---------|
| `subscribe` | `gap-replay`（当 `lastMsgId` 有效）+ `ack` | `error{forbidden}`（user 越权） |
| `unsubscribe` | `ack` | — |
| `prompt` | `ack{requestId}` | `error{not_ready}` |
| `ping` | `pong{ts}` | — |
| bad JSON / schema 不合 | — | `error{bad_request}` |

---

## 时序图

### subscribe 带 lastMsgId（gap-replay 回放路径）

```
前端                  ws-handler            subscription-manager      gap-replayer        message-store
 │                      │                          │                      │                    │
 ├─ {subscribe,team,t1, ─▶ isWsUpstream ✓           │                      │                    │
 │  lastMsgId='msg_5'}  │                          │                      │                    │
 │                      ├─ subscribe('c1',team:t1)─▶ subs.add('team:t1')  │                    │
 │                      ├─ buildGapReplay ────────────────────────────────▶                    │
 │                      │                          │                      ├─ listTeamHistory ─▶ [msg_6..msg_9]
 │                      ◀─────── GapReplayResult(items, upTo='msg_9') ────┤                    │
 │ ◀─ {type:'gap-replay', items:[..], upTo:'msg_9'} (先)                  │                    │
 │ ◀─ {type:'ack', ok:true}                          (后)                 │                    │
```

关键点：**gap-replay 必须在 ack 之前发**，前端据此区分"补发完成"与"订阅就绪"。同一 tick 内 send 两次在 `ws` 底层保证次序（事件循环单线程）。

### prompt fire-and-forget

```
前端                  ws-handler            driverRegistry          AgentDriver           BusBridge
 │                      │                          │                      │                    │
 ├─ {prompt,inst_a,'hi',r42} ─▶ get('inst_a') ────▶ driver               │                    │
 │                      ├─ driver.isReady() ? ──── true                  │                    │
 │                      ├─ driver.prompt('hi') ────────────▶              │ ACP.prompt ────────▶│ (异步)
 │                      │   (不 await，catch 吞掉 reject)  │              │                    │
 │ ◀─ {type:'ack',requestId:'r42',ok:true} (立即)                         │                    │
 │                                                          │ session updates… ────────────────▶ emit driver.thinking
 │                                                          │                   ────────────────▶ emit driver.text
 │                                                          │ turn done         ────────────────▶ emit driver.turn_done
 │ ◀─ (W2-2 ws-broadcaster 推送以上 driver.* 事件)           │                    │
```

关键点：ack 先到、driver.* 事件后到；前端靠 `requestId` 把 ack 和自己发出的 prompt 对上，后续事件按 `driverId=inst_a` 过滤。

---

## 竞态分析

| 场景 | 风险 | 对策 |
|------|------|------|
| **subscribe 与连接 close 并发** | close 在 ws-upgrade 里先调 `subscriptionManager.removeConn`；随即到达的 subscribe 拿不到 conn 记录 | subscription-manager 对未 addConn 的调用静默 no-op（W1-B 防御式设计），本 handler 不必额外判空 |
| **N 条 subscribe 同一 tick 到达** | 多次重复 subscribe 同一 (scope,id) | subscription-manager 用 Set 去重，幂等 |
| **prompt 期间前端断线** | driver.prompt 仍在 ACP 往返中；断开后 ack 走不出去 | `sendDown` 里 try/catch 吞 send 错误；driver.* 后续事件由 broadcaster 自行判连接存活 |
| **driver.prompt reject** | 若 await 并回 error 会污染"fire-and-forget"语义，也和 driver.error 事件重复 | 不 await；`.catch` 吞掉。driver 自己会 emit `driver.error` 上 bus，前端从事件流感知 |
| **bad JSON 穿透** | 前端误发/攻击者注入畸形数据 | `JSON.parse` try/catch → error{bad_request}；连接不断 |
| **connectionId 冲突** | ws-upgrade 保证 uuid 唯一；若外部传入重复会被 subscription-manager 的 Map 覆盖 | 契约上限定调用方生成唯一 id，本 handler 不自行校验 |

---

## 错误传播

| 来源 | 本 handler 行为 | 前端可观察到的 |
|------|----------------|---------------|
| JSON parse 失败 | 捕获 → `error{bad_request,'json parse failed'}` | error 下行；连接保持 |
| isWsUpstream false | 不 throw → `error{bad_request,'schema invalid'}` | error 下行；连接保持 |
| user 越权订阅 | 不进 subscription-manager → `error{forbidden,'cannot subscribe other user'}` | error 下行；订阅未建立 |
| driver 不存在 / 未 READY | 不 throw → `error{not_ready,'driver <id> not ready'}` | error 下行；未触发 ACP 调用 |
| `driver.prompt` reject | 静默吞；driver 自身 emit `driver.error` | 事件流里出现 `driver.error`；连接保持 |
| `ws.send` 抛错 | try/catch 吞 | —（连接可能已断） |

**没有一个路径会让 WS 连接主动 close。** 连接关闭必须来自 peer close、ws-upgrade 层或 HTTP server shutdown。

---

## 为什么 `commRegistry` 在 deps 里但这里不用它

W2-1 的职责是"上行路由"。用户地址注册/注销属于**连接生命周期**，在 ws-upgrade 层做（W2-3 user-session）。但 `commRegistry` 写在 `WsHandlerDeps` 里是为了保持每条 WS 连接的 context 形状一致：后续 W2-2 broadcaster、W2-6 notification 都会拿同一份 deps，handler 只是**不用**并非**不挂**。

---

## REGRESSION 覆盖

| 条目 | 覆盖位置 |
|------|---------|
| R1-1 subscribe 正确被路由 | test `subscribe › 不带 lastMsgId` |
| R1-2 subscribe + lastMsgId 触发 gap-replay | test `subscribe › 带 lastMsgId` |
| R1-3 ping → pong | test `ping` |
| R1-4 prompt 转发给 driver | test `prompt › driver READY` |
| R1-5 prompt 到非 READY | test `prompt › driver 不存在 / 未 READY` |
| R1-6 bad JSON | test `异常路径 › bad json` |
| R1-10 user 越权被拒 | test `subscribe › user scope` |

R1-7 / R1-8 / R1-9 由 W2-2 broadcaster、ws-upgrade、gap-replayer 自身各自覆盖，不落在本模块。

---

## 非功能

- 单文件 166 行（≤200）
- 不 import `bus/*`、不 import `db/*`（db 通过 gap-replayer 的 messageStore 注入）
- 不 mock db/bus，测试用 `:memory:` SQLite + 真 SubscriptionManager + 真 DriverRegistry + 假 WS（EventEmitter）
