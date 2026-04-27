# Phase：通信管道 — 进度总表

**版本**：v1 · **创建日期**：2026-04-25 · **状态**：🔲 规划中 · **架构师**：arch-comm-a

---

## 1. Phase 概述

上一个 Phase（Sandbox-ACP）交付了 34 个模块，把运行时 / driver / 成员 ACP 协议全部换成了统一接口，但**通信管道**还停留在"旧 payload + 字符串拼接"。本 Phase 把通信彻底模型化：

1. **接通上个 Phase 的 3 根断线**（阻塞项，所有下游业务依赖）
   - `member-driver` subscriber 未进 `bootSubscribers` → 成员 activate 后 bus 没有生命周期订阅，driver 永远起不来
   - `driverDispatcher` 未接入 `server.ts` → CommRouter 只会走 socket/offline，`send_msg` 推模式形同虚设
   - `member-driver/index.ts` 聚合入口缺失 → bus 无统一挂载点

2. **Envelope 通信模型**（本 Phase 核心）
   基于 `docs/phase-sandbox-acp/comm-model-design.md` + `comm-model-frontend.md`：
   - 全链路单一数据结构 `MessageEnvelope` + `ActorRef`
   - 发送方身份（`from.kind`）在 hub 入口强注入，防伪造
   - `send_msg` / `read_message` / `check_inbox` 三件套分离"发 / 读全文 / 查未读摘要"
   - driver 注入的提示只保留**一行摘要**：`@<displayName>>${summary}  [msg_id=<id>]`
   - `messages` 表扩列（`from_kind` / `envelope_uuid` / `attachments_json` 等），统一写入入口
   - bus 事件 `comm.message_sent` / `comm.message_received` 升级字段（沿用 type，补 payload）
   - 新增前端 HTTP API：`POST /api/messages/send` / `GET /api/messages/:id` / `GET /api/role-instances/:id/inbox` / `GET /api/teams/:teamId/messages`

3. **check_inbox 改造**
   只返摘要列表，不含 `content`；需要全文走 `read_message(id)`。
   对应需求原话："agent 收到消息只看到通知：`@老王>报告做完了请查收`，想看详情主动调工具"。

---

## 2. 架构全景图

### 2.1 改造前（现状痛点）

```
 agent A                           hub                           agent B
 ─────────                         ─────                         ─────────
 send_msg(to,sum,ctt) ──► CommLike.send({to,payload}) ──► CommRouter.dispatch(Message)
                                                                  │
                                                                  ├─ extractText = summary+'\n\n'+content (router.ts:26-32)
                                                                  ├─ driverDispatcher?(未接入 server.ts) → 永远跳过
                                                                  ├─ socket write (只有 CommClient 模式有效)
                                                                  └─ offline.store (对端不在线)
                                                                         │
                                                     成员 activate        │
                                                     (member-driver       │
                                                      subscriber 未接)    │
                                                            ✗ 无响应      │
                                                                         ▼
                                                                  messages 表
                                                                  (只有 summary+JSON blob)
```

三条红线：
- `bus/index.ts:29-53` 的 `bootSubscribers` 不包含 member-driver，`instance.created` 永远没人响应
- `http/server.ts:55-66` 起 CommServer 时没注入 `driverDispatcher`（`comm/router.ts:43` 字段是 `undefined`），推送模式失效
- `member-driver/index.ts` 不存在，bus 侧无聚合入口

### 2.2 改造后（目标架构）

```
 ┌────────────────────────────────────────────────────────────────────────────────┐
 │                    mteam 通信模型 · 目标架构（Phase 完成后）                       │
 └────────────────────────────────────────────────────────────────────────────────┘

   [用户] ─HTTP POST /api/messages/send──┐
                                         │                         [agent A]
   [bus subscriber] ─system 内部调用─┐    │                         send_msg / read_message
                                    │    │                         (MCP tools)
                                    ▼    ▼                             │
                               ┌──────────────────────┐                │ CommLike.send
                               │  EnvelopeBuilder      │◄──────────────┘
                               │  （纯函数，新增）       │
                               │  - from.kind 强注入    │
                               │  - lookup 补 to 全字段│
                               │  - 生成 ts / teamId   │
                               └──────────┬───────────┘
                                          │ MessageEnvelope
                                          ▼
                               ┌──────────────────────┐
                               │   CommRouter.dispatch│
                               │  (改造：吃 envelope)  │
                               └──────────┬───────────┘
                                          │ 1. MessageStore.insert (唯一写入口)
                                          │    → messages 表 → dbId → envelope.id = `msg_${dbId}`
                                          │
                                          │ 2. bus.emit 'comm.message_delivered'
                                          │    payload 内带完整 Envelope
                                          │
                                          │ 3. 路由（scope/system/driver/socket/offline）
                                          ▼
          ┌────────────────────────┬────────────────────────┐
          ▼                        ▼                        ▼
    local:system            driverDispatcher         socket.write / offline
    (systemHandler)         (改造：注入摘要)                  │
                            `@<from>>${summary}` ──►  [agent B ACP driver]
                                                       │
                                                       ├─ 看到一行通知 + msg_id
                                                       └─ 需要全文 → read_message(msg_id)
                                                                       │
                                                                       ▼
                                                                MessageStore.findById
                                                                → 完整 envelope
                                                                → markRead?

          (同时) ws.subscriber 监听 comm.message_delivered → 推给前端
                  前端拿到 Envelope 直接渲染，无需二次查询
```

### 2.3 模块拓扑（本 Phase 新增 / 改造）

```
                         ┌───────────────────┐
                         │ comm/types.ts     │  (扩 MessageEnvelope / ActorRef)
                         └─────────┬─────────┘
                                   │ import type
          ┌────────────────────────┼─────────────────────────┐
          ▼                        ▼                         ▼
 ┌──────────────────┐   ┌──────────────────┐   ┌─────────────────────┐
 │ envelope-builder │   │ message-store    │   │ mcp/tools/read_msg  │
 │ （纯函数，Wave 1） │   │ (DAO，Wave 1)    │   │ （纯工具，Wave 1）   │
 └────────┬─────────┘   └────────┬─────────┘   └──────────┬──────────┘
          │                      │                        │
          └──────────┬───────────┘                        │
                     ▼                                    │
            ┌────────────────────┐                        │
            │ CommRouter（改造）  │ ◄──────────────────────┘
            │ driverDispatcher   │                     业务胶水 Wave 2
            │ send_msg / inbox   │
            │ message-persister  │ ◄── subscribe bus.comm.message_delivered
            │   subscriber        │       （把 Envelope 写 messages 表，接替 offline.store）
            └──────────┬─────────┘
                       │
                       ▼
          ┌────────────────────────┐
          │ bus/subscribers/       │
          │   member-driver/       │
          │   index.ts (Wave 2)    │ ◄── Wave 2 第一件事：聚合 + 挂 bootSubscribers
          └────────────────────────┘
                       │
                       ▼
          ┌────────────────────────┐
          │ http/server.ts (Wave 2)│ ◄── 启动链接入 driverDispatcher
          └────────────────────────┘
                       │
                       ▼
          ┌────────────────────────┐
          │ http/routes/           │
          │   messages.routes.ts   │ ◄── Wave 2: POST send / GET :id / inbox / team
          │   (新增)                │
          └────────────────────────┘
```

---

## 3. Stage 列表

本 Phase 单 Stage 执行（模块内部依赖明确，分 Stage 只会增加协调成本），按 **Wave** 推进：

| Wave | 内容 | 前置 | 估时 | 状态 |
|------|------|------|------|------|
| **W1** 非业务模块（可并行） | 4 个纯净模块：`envelope.ts` 类型 / `envelope-builder.ts` / `message-store.ts` / `read_message.ts` 工具 | — | 0.5d | 🔲 |
| **W2** 业务胶水（部分并行） | 断线修复（index + bootSubscribers + server 接线）+ router 改造 + send_msg/check_inbox 改造 + message-persister subscriber + bus 事件升级 + HTTP routes + format-message | W1 全部完成 | 1.5d | 🔲 |
| **W3** 回归测试 | 按 REGRESSION.md 逐条验 | W2 | 0.5d | 🔲 |

**总工时**：2.5 个工作日

---

## 4. 关键依赖关系

```
   W1-A envelope.ts (类型定义)
        │ import type
        ├──────────────────┬──────────────────┬──────────────────┐
        ▼                  ▼                  ▼                  ▼
   W1-B builder       W1-C message-store   W1-D read_msg      W2-*
        │                  │                  │
        └─────┬────────────┴──────────┬──────┘
              ▼                        ▼
          W2-A member-driver/index + bootSubscribers  ← 解断线 #1 #3
          W2-B server.ts 接入 driverDispatcher        ← 解断线 #2
          W2-C router.ts 改吃 envelope + 发 bus 事件
          W2-D send_msg 改造（吃 W1-B builder）
          W2-E driver-dispatcher 改造（摘要 vs 全文）
          W2-F check_inbox + format-message 改造
          W2-G message-persister subscriber（subscribe bus → 写 store）
          W2-H bus/types.ts 字段升级 + ws 白名单
          W2-I HTTP routes：messages.routes.ts
          W2-J DB migration：messages.sql 扩列

   W3 回归：挨条跑 REGRESSION.md
```

---

## 5. 验收标准

- [ ] 三根断线全部接通：`activate` 成员后 driver 自动 start、`send_msg` 对在线对端走推送、`member-driver/index.ts` 被 `bootSubscribers` 调用
- [ ] 全链路使用 `MessageEnvelope`，`comm/router.ts` 的 `dispatch` 参数类型为 `MessageEnvelope`（不是 `Message`）
- [ ] `send_msg` 返回 `{ delivered, messageId, route }`，`read_message` 可据 id 取回完整 envelope
- [ ] `check_inbox` 返回的每条只有 `id / from / summary / kind / replyTo / ts / readAt`，**无 `content`**
- [ ] driver.prompt 注入文本严格形如 `@<displayName>>${summary}  [msg_id=msg_123]`（单行，无全文）
- [ ] `messages` 表扩列完成，老数据已 backfill `envelope_uuid`
- [ ] `comm.message_delivered` / `comm.message_received` 的 bus 事件 payload 包含完整 `Envelope`
- [ ] WS 白名单包含新事件类型（若新增）；前端订阅收到带 envelope 的推送
- [ ] `POST /api/messages/send`、`GET /api/messages/:id`、`GET /api/role-instances/:id/inbox?peek=`、`GET /api/teams/:teamId/messages` 四个 HTTP 端点可用
- [ ] REGRESSION.md 逐条通过
- [ ] 每个新文件 ≤ 200 行；非业务模块不 import 业务代码（编译期可验）

---

## 6. 关键设计决策（写给下一个 agent）

1. **bus 事件 payload 直接带 Envelope，不再二次查询**
   前端设计文档（Part B §6.3）原方案是"推 messageId + 前端 HTTP 反查"；本期改为 **bus 事件直接携带完整 Envelope**（新增事件 `comm.message_delivered`），原因：
   - 省一次 HTTP 往返；
   - 前端订阅者和 WS 订阅者共用同一份数据；
   - 后端 `message-persister` subscriber 也可以直接吃事件写库，职责单一。
   老事件 `comm.message_sent` / `comm.message_received` 保留字段兼容（只带 messageId），作为审计/指标用。

2. **MessageStore 写入入口移到 subscriber，不在 router 内联**
   现状 `offline.store()` 只在不在线时写；本期拆成：
   - `CommRouter.dispatch` 先构造 envelope（id 留空）→ `bus.emit comm.message_delivered { envelope }`
   - `message-persister.subscriber` 订阅该事件 → 调 `MessageStore.insert` → 写入 DB → 回填 id（通过对比 envelope id 生成算法一致）
   好处：router 纯路由、DAO 纯写库、subscriber 纯协调，三者零耦合。
   折衷：envelope.id 生成必须在 router 阶段就能确定（不能依赖 DB autoincrement）。用 `crypto.randomUUID()` 或 `msg_<sortable>`，DB 存 uuid 而非绑定 rowid。

3. **`from.kind` 的强注入发生在 `CommLike.send` / HTTP handler / subscriber 三处入口**
   `EnvelopeBuilder` 是**纯函数**（见 Wave 1），负责根据 `fromKind` 入参和 registry 查询组装 Envelope；业务入口在调用时传入固定 `fromKind`，不给调用方可覆写的路径。

4. **`check_inbox` HTTP 端点现在才真正实装**
   代码里 `check_inbox.ts:27` 一直调 `/api/role-instances/:id/inbox`，但搜整个仓库没有这个路由（见 `grep -rn "inbox" packages/backend/src/`）—— 工具从来没跑通过。本期和前端 HTTP API 一起落地。

5. **旧 `offline.store` / `formatMemberMessage` 保留 shim 过渡**
   `replay.ts:60` 当前用 `formatMemberMessage`；迁移到 `formatNotifyLine` 后，旧函数保留一个 shim（内部 delegate），等测试全绿再删。否则一次改全链路极易漏 subscriber。

---

## 7. 相关文档

- 必读后端设计：`/Users/zhuqingyu/project/mcp-team-hub/docs/phase-sandbox-acp/comm-model-design.md`
- 必读前端设计：`/Users/zhuqingyu/project/mcp-team-hub/docs/phase-sandbox-acp/comm-model-frontend.md`
- 接口契约：`/Users/zhuqingyu/project/mcp-team-hub/docs/phase-sandbox-acp/INTERFACE-CONTRACTS.md`（driver/runtime 契约保持冻结，本 Phase 新增 envelope 契约另立）
- 工作流：`/Users/zhuqingyu/project/mcp-team-hub/docs/phase-sandbox-acp/WORKFLOW.md`
- 上游断线：`packages/backend/src/bus/subscribers/member-driver/README.md`（lifecycle / replay / pid-writeback 已存，缺 index 聚合）

---

## 8. 状态图例

- 🔲 待开始 · 🟡 进行中 · ✅ 已完成 · ⚠️ 受阻 · ⏸️ 暂缓
