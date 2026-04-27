# Phase: WS —— WebSocket 双工 + 订阅过滤 + 通知系统 + user 注册

**版本**: v1 · **创建日期**: 2026-04-25 · **状态**: 🔲 规划中 · **架构师**: arch-ws-a

> ⛔ **本文档主体为服务端底层实现规划，禁止前端调用**（§2.3 消息 uid/gap 机制、§5.6 下行消息 id 两处为前后端共享契约，除外）

> **受众分层**：
> - **后端实现者 / 架构师**：全文。§2 架构图 / §3 Wave 拆分 / §5 关键决策 的模块路径 / §6 冻结契约。
> - **前端实现者**：只关心 §1.2 目标 / §2.3 消息 uid + gap 机制 / §4 验收标准（第 1、2、6、7 条）/ §5.6 下行消息必带 id —— 这些是前端消费 WS 协议时需要了解的前端契约；其余章节属后端实现细节。
> - **非受众**：前端不需要按 §2.2 拓扑图自己实现 ws-handler / ws-broadcaster / subscription-manager / visibility-filter —— 这些都是后端模块。前端对接协议见 `docs/frontend-api/ws-protocol.md`。

---

## 0. 用户目标（原话，逐条必须覆盖）

1. "前端通过 websocket 对接，全是双工" —— agent 通信相关、消息通知用 WS，CRUD 保留 HTTP
2. "不能每一次都把所有数据都返回来，得有一个订阅机制" —— 精细订阅 scope+id，不订阅不推
3. "用户也是一个特殊地址，注册到 comm 里" —— WS 连接时注册 `user:<id>`
4. "comm 不承接业务逻辑，所有可见不可见是过滤器的逻辑，独立维护配置 DB"
5. "通知系统，全代理/不代理/自定义代理"
6. "成员回复用户就是普通对话，不走 comm" —— agent 的 assistant 输出就是回复，driver.text 事件推前端
7. "每条消息有 uid，subscribe 带 lastMsgId 回补 gap，前端用 id 去重"

本文档所有设计可被以上 7 条原话直接验证。偏离即漂移。

---

## 1. Phase 概述

### 1.1 现状痛点（`WS 对接现状` id:419）

| 痛点 | 代码位置 |
|------|---------|
| WS 单路径 `/ws/events` 全量广播（34 类事件） | `bus/subscribers/ws.subscriber.ts:12-47` |
| 无订阅过滤，前端收到所有实例所有成员事件 | `ws.subscriber.ts:80-93` |
| 无上行 message —— WS 只推不收，前端无法通过 WS 发 prompt / subscribe | `ws-upgrade.ts` 全文 |
| user 未注册到 comm —— 用户地址 `user:local` 硬编码，无法多用户、无在线感知 | `comm/registry.ts` 全文 |
| comm 层混杂业务（比如"谁能看谁的消息"该属于业务侧，不应该在 router 里判定） | `comm/router.ts:56-108` |
| 通知系统缺位 —— 系统事件（成员崩溃 / 团队解散 / 任务完成等）直接广播，没有"谁该收"的语义 | — |
| agent 回复用户靠 `send_msg` 工具发消息 —— 应该直接用 driver.text 流 | `mcp/tools/send_msg.ts` |
| 前端 gap 恢复无机制 —— 断线重连后丢事件 | — |

### 1.2 本 Phase 目标

1. **WS 双工协议**：上行 `subscribe / unsubscribe / prompt / ping`，下行 `event / pong / error / gap-replay`
2. **精细订阅**：per-connection 订阅状态机 `{ scope: 'instance'|'team'|'user'|'global', id?: string }`
3. **Gap 补发**：subscribe 带 `lastMsgId` → 从 DB 拉缺失消息回补
4. **业务过滤器层**：独立模块 + 独立表（`visibility_rules`），comm 只做路由、过滤器决定谁能看见谁
5. **通知系统**：`全代理 / 不代理 / 自定义代理` 三模式，按用户偏好配置
6. **user comm 注册**：WS 连接时注入 `user:<id>`（或 `user:local` 单用户降级）→ comm registry → 用户可接收系统消息 / agent 直接消息
7. **agent 回复用户**：driver.text 事件按订阅推给前端（不走 comm router，不落 messages 表）

### 1.3 与 phase-comm 的分工

| 关注点 | phase-comm（上一 Phase） | phase-ws（本 Phase） |
|--------|---------------------|---------------------|
| MessageEnvelope 数据结构 | ✅ 定义 + 落库 | 消费 |
| `comm.message_sent` / `comm.message_received` bus 事件 | ✅ router 内 emit | 按订阅过滤推 |
| messages 表 | ✅ 建表 + DAO | 查询（gap replay） |
| send_msg / read_message / check_inbox 工具 | ✅ | 不改 |
| **WS 订阅 / 双工 / 过滤 / 通知** | — | ✅ 本期核心 |
| **user 注册到 comm** | — | ✅ |
| **driver.text → 前端** | — | ✅（按订阅） |

---

## 2. 架构全景图

### 2.1 WS 连接 → 订阅 → 事件过滤 → 推送 完整链路

```
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                    phase-ws 架构（单连接视角）                                    │
 └─────────────────────────────────────────────────────────────────────────────────┘

   浏览器                                                               Hub Process
 ┌─────────┐                                                         ┌──────────────┐
 │  前端    │                                                         │              │
 │  WS      │                                                         │              │
 │ client   │                                                         │              │
 └────┬────┘                                                          │              │
      │ ① TCP upgrade /ws/events?userId=u1                            │              │
      │ ──────────────────────────────────────────────────────►       │              │
      │                                       ┌──── ws-upgrade.ts ────┤              │
      │                                       │ 认证/解析 userId       │              │
      │                                       │ 派生 connectionId     │              │
      │                                       ▼                       │              │
      │                              ┌─────────────────────┐          │              │
      │                              │ user-session        │ 调 comm.registry        │
      │                              │ register user:u1    ├─────────►│ register    │
      │                              └──────────┬──────────┘          │ 'user:u1'   │
      │                                         │                     │ → conn      │
      │                                         ▼                     │              │
      │ ② 上行: {op:'subscribe', scope:'team', id:'team_01',          │              │
      │         lastMsgId:'msg_1420'}                                 │              │
      │ ──────────────────────────────────────────────────────►       │              │
      │                                       ┌── ws-handler.ts ──────┤              │
      │                                       │ 路由 op               │              │
      │                                       ├─► subscription-manager│              │
      │                                       │    .subscribe(conn,   │              │
      │                                       │     {scope:team,id})  │              │
      │                                       │                       │              │
      │                                       ├─► gap-replayer        │              │
      │                                       │    .replay(conn,      │              │
      │                                       │     'msg_1420', team) │              │
      │                                       │    从 messageStore    │              │
      │                                       │    .listTeamHistory   │              │
      │                                       │    回补 missing 行     │              │
      │  ◄── 下行: {type:'gap-replay', items:[...N条], upTo:'msg_1423'}              │
      │                                                                              │
      │ ③ bus 事件流动（同进程）                                                      │
      │                                                                              │
      │   comm.message_sent            driver.text                 team.member_joined │
      │   (phase-comm emit)            (driver 进程 emit)          (roster emit)      │
      │          │                            │                            │         │
      │          └────────────┬───────────────┴────────────┬───────────────┘         │
      │                       ▼                            ▼                         │
      │                ┌────────────────────────────────────────────┐                │
      │                │ ws-broadcaster.ts （改造 ws.subscriber）    │                │
      │                │   subscribe bus.events$                    │                │
      │                │   对每个 client：                           │                │
      │                │     a. subscription-manager.match(conn, e) │                │
      │                │        → 不订阅? drop                       │                │
      │                │     b. visibility-filter.canSee(conn.user, │                │
      │                │        e)                                   │                │
      │                │        → 不可见? drop                       │                │
      │                │     c. toWsPayload(e) + send                │                │
      │                └─────────────────┬──────────────────────────┘                │
      │                                  │                                           │
      │  ◄── 下行: {type:'event', ...}                                                │
      │                                                                              │
      │ ④ 上行: {op:'prompt', text:'帮我分析...'}                                      │
      │ ──────────────────────────────────────────────────────►                       │
      │                                       ┌── ws-handler.ts ──────┤              │
      │                                       │ 找主 agent driver     │              │
      │                                       │ driver.prompt(text)   │              │
      │                                       │                       │              │
      │                                       │ driver 回包括 text /  │              │
      │                                       │ thinking / turn_done  │              │
      │                                       │ 的事件，经 ③ 链路      │              │
      │                                       │ 按订阅推回前端         │              │
      │                                       └───────────────────────┤              │
      │                                                                              │
      │ ⑤ 通知系统（独立）                                                             │
      │     bus.instance.crashed / team.disbanded / 自定义通知事件                     │
      │              │                                                                │
      │              ▼                                                                │
      │     notification.subscriber                                                   │
      │       - 读 notification-store 配置（全代理/不代理/自定义）                       │
      │       - 全代理 → 调 commRouter.dispatch(envelope{from:system, to:primaryAgent}) │
      │       - 不代理 → emit 'notification.deliver' { to:'user:u1', ... }            │
      │       - 自定义 → 按规则选 to                                                    │
      │              │                                                                │
      │              ▼                                                                │
      │     通知流经 ③ ws-broadcaster 按订阅推给目标 user/agent                         │
      │                                                                              │
      │ ⑥ 断开: socket close                                                         │
      │                                       ┌── ws-handler.ts ──────┤              │
      │                                       │ subscription-manager  │              │
      │                                       │ .removeConn(conn)     │              │
      │                                       │ user-session.         │              │
      │                                       │   unregister('user:u1')              │
      │                                       └───────────────────────┤              │
      └──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 模块拓扑（本 Phase 新增 / 改造）

```
  ws/protocol.ts  (W1-A, 非业务)             filter/types.ts    (W1-E, 非业务)
  ws/subscription-manager.ts (W1-B, 非业务)  filter/filter-store.ts (W1-F, 非业务)
  ws/gap-replayer.ts  (W1-C, 非业务)         notification/types.ts  (W1-G, 非业务)
                                            notification/notification-store.ts (W1-H, 非业务)
           │           │                           │                  │
           └───────────┴────────────┬──────────────┴──────────────────┘
                                    │ import type
                                    ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │   Wave 2（业务胶水，部分并行）                                    │
  │                                                                 │
  │   ws/ws-handler.ts   (W2-1) —— 上行路由：subscribe/prompt/ping  │
  │   ws/ws-broadcaster.ts (W2-2) —— 改造 ws.subscriber，按订阅过滤 │
  │   ws/user-session.ts (W2-3) —— WS 连接 ↔ comm.registry          │
  │                                                                 │
  │   filter/visibility-filter.ts (W2-4) —— 过滤逻辑，查 filter-store │
  │                                                                 │
  │   notification/proxy-router.ts (W2-5) —— 代理模式路由             │
  │   bus/subscribers/notification.subscriber.ts (W2-6)              │
  │                                                                 │
  │   bus/ws-upgrade.ts（改造）—— 抽出 userId，接 ws-handler         │
  │   bus/index.ts（改造）—— 注册 notification.subscriber            │
  └─────────────────────────────────────────────────────────────────┘
```

### 2.3 消息 uid 与 gap 机制（用户原话 #7）

> **面向**：**前端 + 后端双方契约**。前端必须按 `id` 去重、必须在 subscribe 时带 `lastMsgId`；后端必须在 makeBase 注入 `eventId` 并在 gap 回补时用 `after` 游标查 messageStore。

**uid 来源**：所有 bus 事件 payload 里带一个稳定的 `eventId`（目前没有 —— 需要新增；对 `comm.*` 事件复用 `messageId`）；下行 WS 消息里带 `id` 字段，前端用它去重。

**gap 补发流程**：

```
前端断线 → 本地记住最后一条 id = msg_1420
 ↓ 重连
前端发: { op:'subscribe', scope:'team', id:'team_01', lastMsgId:'msg_1420' }
 ↓
ws-handler
  ↓
gap-replayer.replay(conn, lastMsgId='msg_1420', scope)
  ↓
messageStore.listTeamHistory(team_01, { after:'msg_1420', limit:200 })
  （phase-comm 的 store 是 before 游标，本期需补 after 能力）
  ↓
逐条推下行 { type:'gap-replay', items:[env1, env2, ...], upTo:'msg_1423' }
  ↓ 前端收到后，再收普通 event 推送 —— 用 id 去重
```

**事件 uid 和消息 uid 的关系**：
- 对 `comm.*` 事件：`eventId = messageId = envelope.id`（已有）
- 对非 comm 事件（driver / team / instance 等）：gap 不回补（这类事件是瞬时状态变更，重连后用 HTTP 拉快照更合理）—— 本期 gap 只覆盖 `comm.*`（即用户/agent 聊天消息）

---

## 3. 功能拆分（单 Stage，按 Wave）

本 Phase 仍用单 Stage + Wave 推进（模块内部依赖明确，分 Stage 只会增加协调成本）：

| Wave | 内容 | 前置 | 估时 |
|------|------|------|------|
| **W1** 非业务模块（并行 8 件） | 4 功能各自的"纯类型 / 数据结构 / DAO"层 —— 见 TASK-LIST.md §W1 | — | 0.5d |
| **W2** 业务胶水（部分并行，6 件） | 上行路由 + 改造 broadcaster + user 注册 + 可见性过滤 + 通知代理 + notification subscriber | W1 全部完成 | 1.5d |
| **W3** 回归测试 | 按 REGRESSION.md 逐条验 | W2 | 0.5d |

**总工时**：2.5 工作日

### 3.1 功能 ↔ 模块矩阵

| 功能 | W1 非业务 | W2 业务 |
|------|-----------|---------|
| 1. WS 双工协议 | W1-A `ws/protocol.ts`<br>W1-B `ws/subscription-manager.ts`<br>W1-C `ws/gap-replayer.ts` | W2-1 `ws/ws-handler.ts`<br>W2-2 `ws/ws-broadcaster.ts` |
| 2. 业务过滤器 | W1-E `filter/types.ts`<br>W1-F `filter/filter-store.ts` | W2-4 `filter/visibility-filter.ts` |
| 3. 通知系统 | W1-G `notification/types.ts`<br>W1-H `notification/notification-store.ts` | W2-5 `notification/proxy-router.ts`<br>W2-6 `bus/subscribers/notification.subscriber.ts` |
| 4. user comm 注册 | —（无独立非业务） | W2-3 `ws/user-session.ts` |

---

## 4. 验收标准（对齐用户 7 条原话）

| # | 原话 | 验收点 |
|---|------|--------|
| 1 | "全是双工" | WS 上行可发 `{op:'subscribe'}` / `{op:'prompt'}` / `{op:'ping'}`；下行带 `type` 区分 `event/pong/error/gap-replay` |
| 2 | "精细订阅，不订阅不推" | 没 subscribe `team:team_01` 的连接不会收到 `team_01` 下的 comm/driver 事件；可断言"A subscribe team_01，B subscribe team_02，B 收不到 A 的消息" |
| 3 | "user 注册到 comm" | WS 连接后 `comm.registry.has('user:u1') === true`；`send_msg(to:user:u1)` 能把消息投给前端用户 |
| 4 | "comm 不承接业务逻辑" | `comm/router.ts` 无任何 visibility 相关 import；所有过滤在 `filter/visibility-filter.ts`；`filter_rules` 独立表 |
| 5 | "通知全代理/不代理/自定义" | `notification_configs` 表有 `mode: 'proxy_all' \| 'direct' \| 'custom'`；`notification.subscriber` 按 mode 选 to |
| 6 | "成员回复用户走 driver.text，不走 comm" | 前端订阅 `instance:inst_leader_01` 后，agent 的 `driver.text` 推到前端；不经过 comm router，messages 表不落库 |
| 7 | "uid + gap 回补 + 前端去重" | subscribe 带 `lastMsgId` 时下行先 `gap-replay` 再正常 event；所有下行消息带 `id`，前端可按 id 合并 |
| — | 非业务模块不 import 业务代码 | grep `ws/protocol.ts` / `subscription-manager.ts` / `filter/types.ts` / `notification/types.ts` 等，只 import type；`tsc --noEmit` 不报循环 |
| — | 每文件 ≤ 200 行 | `wc -l packages/backend/src/ws/*.ts filter/*.ts notification/*.ts` 每行 ≤ 200 |
| — | 不 mock db/bus 的测试全绿 | `bun test` 在 `packages/backend/src/` 下 exit code 0；每个新模块有对应 `*.test.ts` 且不 mock |
| — | REGRESSION.md 每条通过 | 测试员交付报告覆盖所有场景 |

---

## 5. 关键设计决策

### 5.1 comm 层零业务逻辑

用户原话 #4：`comm 不承接业务逻辑，所有可见不可见是过滤器的逻辑，独立维护配置 DB`。

**怎么做**：
- `comm/router.ts` 保持现状（它本来就只做地址路由 + 落库 + 驱动分发）
- 新增 `filter/visibility-filter.ts`：**在 ws-broadcaster 里**调用 `visibility-filter.canSee(connUser, event) → boolean`
- 过滤器查 `filter/filter-store.ts` 维护的 `visibility_rules` 表
- **禁止**在 `comm/*` 下 import `filter/*`；反之 filter 可以读 comm types

```
反例（禁止）:
  comm/router.ts
    import { canSee } from '../filter/visibility-filter';  ❌

正例:
  bus/subscribers/ws-broadcaster.ts
    import { canSee } from '../../filter/visibility-filter';  ✅
  filter/visibility-filter.ts
    import type { MessageEnvelope } from '../comm/envelope';  ✅
```

### 5.2 订阅是 per-connection 状态，不是 per-user

一个用户可以开多个 tab，每 tab 一条 WS 连接，每条连接有自己的订阅集合（不同 tab 看不同 team）。`subscription-manager` 以 `connectionId` 为 key。

**所以**：`user-session` 管"这个连接代表哪个 user"（为 comm 注册用），`subscription-manager` 管"这个连接订阅了什么"（为推送过滤用），两者是两件事，分两个模块。

**`user` scope 语义收窄（arch-ws-b 审查定稿）**：
- `{op:'subscribe', scope:'user', id:'<uid>'}` **只允许 `id === ctx.userId`**（订阅自己）
- 其他 user id → ws-handler 回 `error{code:'forbidden'}`，不进 subscription-manager
- 越权订阅（u1 订 u2）属于业务权限判定，若未来真要，在 filter 层放规则 —— subscription-manager 不混入这类判断
- 实现：ws-handler 的 subscribe 分支在调 subscription-manager 前做这层校验；subscription-manager 本身保持纯

**`team` / `instance` scope 的 default_policy 扩展位（未来）**：

本期对 `team` / `instance` scope 不做跨用户授权校验（用户原话只要求 user scope 收紧）。但在 `filter/types.ts` 头部注释**预留扩展点**，避免未来加授权时又要改 ws-handler：

```typescript
// filter/types.ts 顶部注释（W1-E 交付时写入）
// 未来扩展：FilterStore 可新增 getDefaultPolicy(scope: 'team'|'instance', id: string, principal)
//   → 'allow' | 'deny'。ws-handler 的 subscribe 分支在 user scope 自校验之后、调
//   subscription-manager 之前查一次；为 'deny' 则 error{forbidden}。
//   本期 default_policy 恒 'allow'（不落表、零运行时开销），W1-E/W1-F 不实现此方法。
```

这样未来接入只需动 filter 层 + ws-handler 一处，subscription-manager 保持纯。

### 5.3 gap replay 只覆盖 `comm.*`

用户原话 #7：`subscribe 带 lastMsgId 回补 gap，前端用 id 去重`。

非 comm 事件（driver 流 / team 生命周期 / instance 状态）重连后不回补，因为：
- driver 事件是实时流，重连后 agent 可能已经 turn_done，补发无意义
- team / instance 状态变更走 HTTP 拉快照更合理

gap replay 调用 `messageStore.listTeamHistory` / `listInstanceUnread`，仅对用户订阅的 scope 回补 comm 消息。

### 5.4 通知代理三模式语义

| 模式 | 含义 | 目标 |
|------|------|------|
| `proxy_all` | 全代理：任何通知都先发给 primary agent，让它决定要不要转给用户 | `to: primaryAgent instance` |
| `direct` | 不代理：通知直接发给 user | `to: user:<id>` |
| `custom` | 自定义：按事件类型 + 规则决定 to | `to: ruleSelector(event)` |

配置存 `notification_configs` 表（单用户场景只一行，多用户场景 per user）。

### 5.5 agent 回复用户 = driver.text 推送

用户原话 #6：`成员回复用户就是普通对话，不走 comm`。

**做法**：
- agent 的 assistant 回复走 ACP `driver.text` 事件（现有，bus/types.ts:224）
- ws-broadcaster 订阅 `driver.text`，按订阅（user 订阅了哪个 instance）推给前端
- **不经过** comm router，**不落** messages 表
- 但**前端把这条 text 也渲染进聊天视图**，和 `send_msg` 发来的消息混合显示 —— 前端视角都是"这个 agent 对我说的话"，来源无感

**用户发消息 → agent 回复** 对称：
- 用户发：前端 WS 上行 `{op:'prompt', text:'...'}` → `driver.prompt(text)` →（此时可选：同步写一条 envelope 到 messages 表以便记录；本期默认**不写**，用户消息只存在于 driver 的 session 历史）
- agent 回复：`driver.text` → ws-broadcaster → 前端

**历史回看（arch-ws-b 审查定稿）**：

选**方案 X**（本期实装）：
- 前端按 `instanceId` 在 **localStorage** 维护 driver.text 缓冲环（定长，例 200 条 / instance）
- 关浏览器 / 清缓存就丢；跨设备看不到
- 与用户原话"不走 comm"对齐；本期可用且零后端改动

**不选** 方案 Y（列未来扩展）：新增独立 `driver_turn_log` 表 + HTTP `GET /api/driver/:id/turns?before=...` 翻页。逻辑上 driver 侧订阅自己 `driver.text` 落盘，仍**不走 messages 表 / 不走 commRouter**，因此并不违反"不走 comm"。方案 Y 留给有明确"跨设备看 agent 历史"需求时再做。

**本期 scope 边界（白纸黑字防歧义）**：
- 本期后端**零** driver.text 持久化
- 本期前端**不**要求实装 localStorage 缓存 —— 前端团队可选做，不阻塞 phase-ws 验收
- REGRESSION R4-3 / R5-1 断言"刷新后看不到 assistant 历史"是**预期行为**，不是 bug

### 5.6 下行消息必带 id，前端去重

> **面向**：**前端 + 后端双方契约**。前端按下行消息 `id` 去重；后端 `bus/helpers.ts::makeBase` 保证所有事件带 `eventId`。

每条下行 WS 消息（`event / gap-replay` 的每条 item）必带 `id` 字段：
- `bus/helpers.ts::makeBase` 改成**强制给所有事件注入 `eventId: string`**（`crypto.randomUUID()`）
- `comm.*` 事件：`eventId = messageId`（语义一致，前端按 messageId 去重）
- driver.* / 其他 bus 事件：下行 `id = eventId`（UUID）
- **不引入 driver seq counter**（arch-ws-b 审查指出：emitter 没这个字段，多一个字段不值当；eventId 已够）

前端统一按下行消息的 `id` 去重。

---

## 6. 与冻结契约的关系

本 Phase **不修改** `INTERFACE-CONTRACTS.md`（§5 修改流程）里的冻结接口：
- `RuntimeHandle` / `ProcessRuntime` / `LaunchSpec` —— 不碰
- `DriverOutputEvent` / `driver.tool_call` bus shape —— 不碰

本 Phase **新增**以下跨模块契约（本 MILESTONE 5.x 已定义，TASK-LIST 详写，但**不进 INTERFACE-CONTRACTS.md**，因为都是 ws/filter/notification 模块内部接口，不跨 Phase）：
- `ClientSubscription` 数据结构
- `WsUpstream` / `WsDownstream` 协议消息
- `VisibilityRule` 数据结构
- `NotificationConfig` 数据结构
- `ConnectionContext`（接到 ws-handler 的 per-connection 状态）

---

## 7. 相关文档

- 共享 Envelope：`packages/backend/docs/phase-sandbox-acp/comm-model-design.md`
- 前端 API（本期会补订阅协议）：`packages/backend/docs/phase-sandbox-acp/comm-model-frontend.md`
- 接口冻结：`packages/backend/docs/phase-sandbox-acp/INTERFACE-CONTRACTS.md`
- 工作流：`packages/backend/docs/phase-sandbox-acp/WORKFLOW.md`
- phase-comm 断线修复与 envelope 落地：`packages/backend/docs/phase-comm/MILESTONE.md`

---

## 8. 状态图例

- 🔲 待开始 · 🟡 进行中 · ✅ 已完成 · ⚠️ 受阻 · ⏸️ 暂缓

---

## 9. 变更日志

| 日期 | 改动 | 作者 |
|------|------|------|
| 2026-04-25 | 初版（W1/W2 拆分 + 7 条原话对齐） | arch-ws-a |
