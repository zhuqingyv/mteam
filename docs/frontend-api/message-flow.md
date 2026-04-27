# 消息三路分发

> **面向**：前端对接人员主读（重点在"第三份"）+ 后端开发者通读（三份同源的契约）。Agent 只消费"第二份"（stdin 的 notifyLine）+ MCP `read_message` 反查 DB，不读本文。

hub 有**两种消息路径**：用户和 agent 的直接对话走 `driver.prompt(text)`（agent 收到原文）；agent 间通信（MCP `send_msg`）和系统通知走 `CommRouter.dispatch(envelope)`（agent 收到通知行）。CommRouter 一条消息拆**三份**同时送出：一份给 **DB**（持久化）、一份给 **agent**（纯文本通知行）、一份给 **前端**（bus 事件）。

前端只消费第三份，但要理解另外两份存在，才能把"消息列表"和"agent 终端输出"对齐成一个产品体验。

## 核心概念

- **Envelope** = 一条消息的完整结构（`id` / `from` / `to` / `summary` / `content` / `kind` / `ts` …），详见 [messages-api.md](./messages-api.md)。
- **一条消息 = 一个 Envelope**，全局唯一 `envelope.id`（形如 `msg_<uuid>`）。
- **三路产物同源**：DB 存的、agent 看到的、前端收到的，都从同一个 envelope 派生，不会分叉。

## 数据流总图

```
 ① WS prompt ─────────► driver.prompt(text) ──► agent 收到原文（不经 CommRouter）

                   ┌────────────────────────┐
 ② HTTP POST send  │                        │   ┌─► ① DB  messageStore.insert
 ③ MCP send_msg    ├─► CommRouter.dispatch ─┼───┼─► ② agent driver (stdin)
 ④ bus subscriber  │       (envelope)       │   │    └── "@name>summary  [msg_id=xxx]"
 (系统通知)        │                        │   │
                   └────────────────────────┘   └─► ③ WS 广播 (bus → ws.subscriber)
                                                     └── comm.message_sent / _received
```

## 三方看到的东西

| 接收方         | 看到的内容                                                                   | 载体                              | 用途                       |
| -------------- | ---------------------------------------------------------------------------- | --------------------------------- | -------------------------- |
| **DB**         | 完整 `MessageEnvelope`（含 `content`/`readAt`）                              | `messages` 表（同步 insert）      | 持久化、查单条、历史翻页   |
| **agent**      | **一行**文本 `@displayName>summary  [msg_id=xxx]`                            | agent driver stdin                | agent 只知道"有消息进来"   |
| **前端（你）** | `comm.message_sent` / `comm.message_received` 事件（只含 `messageId`/`from`/`to`/`route`，**不含 content**） | `/ws/events` 下行 | 列表刷新 + 按需拉正文      |

> **关键**：agent 拿到的只有一行"门铃"；它要看正文必须主动调 `read_message` MCP tool（反查 DB）。前端拿到的事件也只有指针，正文通过 `GET /api/messages/:id` 或 inbox 拉。

## 4 种入口场景

### 场景 1 — 用户在前端聊天框发消息给 agent（WS）

```
 前端              WS 连接         ws-handler          driver
  │  {op:'prompt',   │               │                   │
  │   instanceId,    │               │                   │
  │   text}          │               │                   │
  │────────────────►│───────────────►│ driver.prompt(text)│
  │                  │               │──────────────────►│ agent 收到原文
  │  {type:'ack'}    │               │                   │
  │◄────────────────┴───────────────┤
```

入口：`packages/backend/src/ws/ws-handler.ts::handlePrompt`。
**不经 CommRouter / Envelope**，agent 直接收到用户原文。

### 场景 2 — 用户通过 HTTP POST 发消息给 agent

```
 前端              HTTP           messages.routes       CommRouter
  │  POST /api/      │               │                     │
  │  messages/send   │               │                     │
  │────────────────►│───────────────►│ buildEnvelope       │
  │  {to, content}   │               │ (fromKind='user')   │
  │                  │               │─────────────────────►│ ①②③
  │                  │               │◄─────────────────────│
  │ 200              │◄──────────────┤
  │ {messageId,route}│
  │◄────────────────┤
```

与场景 1 等价，区别只是传输层。响应里的 `messageId === envelope.id`，前端可用它对账随后推来的 `comm.message_sent.messageId`（同值）。

### 场景 3 — agent 之间 send_msg

```
 agentA (CLI)      MCP send_msg     CommRouter           agentB
  │  send_msg({       │               │                    │
  │   to, content})   │               │                    │
  │─────────────────►│──────────────►│ ① DB                │
  │                   │               │ ② notifyLine ─────►│ (stdin)
  │                   │               │ ③ WS 广播 ──► 前端 │
  │ {delivered:true}  │◄──────────────┤
  │◄─────────────────┤
```

前端**同样**收到 `comm.message_sent`（`from.kind='agent'`, `to.kind='agent'`），用来渲染 agent 之间的对话。

### 场景 4 — 系统通知 → agent（bus subscriber 合成）

触发源：领导批准下线 (`instance.offline_requested`)、成员激活 (`instance.activated`) 等业务事件。`comm-notify.subscriber` / `notification.subscriber` 合成 envelope：

```
 业务 bus 事件 ──► subscriber ──► buildEnvelope(fromKind='system', kind='system')
                                    │
                                    └──► CommRouter.dispatch ──► ①②③
```

`from.address='local:system'`、`envelope.kind='system'`。前端按普通消息渲染；如需特殊气泡，按 `envelope.kind === 'system'` 判断，`content` 里可能是 `deactivate` / `member_activated:<id>` 等机器语义字串。

## 通知行格式（agent 视角）

agent 在 stdin 看到的那一行文本，格式严格如下：

```
@<displayName>><summary>  [msg_id=<envelopeId>]
```

- `displayName`：发送方的 alias 或 memberName（`user` 固定 `User`，`system` 固定 `系统`）
- `summary`：envelope.summary（省略时默认 `给你发了一条消息`）
- `>` 后**无空格**，`summary` 与 `[msg_id=...]` 之间**恰好两个空格**
- 正则契约：`/^@[^>]+>.+  \[msg_id=msg_[A-Za-z0-9_-]+\]$/`

## 前端收到的 WS 事件示例

订阅 `/ws/events` 后，每条新消息会推两次（`sent` 和 `received`）：

```json
{
  "type": "event",
  "id": "msg_abc123",
  "event": {
    "type": "comm.message_sent",
    "eventId": "msg_abc123",
    "ts": "2026-04-25T10:00:00.123Z",
    "messageId": "msg_abc123",
    "from": "user:u_42",
    "to": "local:inst_alice"
  }
}
```

```json
{
  "type": "event",
  "id": "msg_abc123",
  "event": {
    "type": "comm.message_received",
    "eventId": "msg_abc123",
    "ts": "2026-04-25T10:00:00.145Z",
    "messageId": "msg_abc123",
    "from": "user:u_42",
    "to": "local:inst_alice",
    "route": "driver"
  }
}
```

> WS 外层 `id` === `event.eventId` === `messageId`，任选一个做去重键。

拉完整 envelope：

```
GET /api/messages/msg_abc123
→ { "envelope": { id, from, to, summary, content, kind, ts, readAt, ... } }
```

## 前端注意事项

- **去重靠 `envelope.id` / `messageId`**：同一条消息可能从 WS、inbox、history 多处拿到；按 id 幂等合并。
- **`sent` 和 `received` 是同一条消息的两个阶段**，不要当两条渲染。`received.route` ∈ `driver | socket | replay`，可用来区分"在线直投"还是"上线回灌"。
- **不要解析 agent 文本**：agent 终端的 `@xxx>...` 只是给 LLM 看的门铃，不是数据源。前端永远用 envelope。
- **content 要自己拉**：WS 事件里只有指针（messageId/from/to），正文/附件在 `GET /api/messages/:id`。想省一次请求可用 `GET /api/role-instances/:id/inbox` 批量拿 `InboxSummary[]`（到 summary 粒度）。
- **乱序容忍**：`sent` 理论先于 `received`，极端情况可能倒序；不要用次序判状态，仅以 `received` 到达视为投递完成。
- **`from` 不可伪造**：HTTP/WS 入口的 `from.kind` 后端强注入为 `user`，body 里传什么都会被覆盖。

## 入口汇总

| 入口             | 调用路径                                                           | 走 CommRouter? |
| ---------------- | ------------------------------------------------------------------ | -------------- |
| 前端 WS prompt   | `ws-handler.handlePrompt` → `driver.prompt(text)`                  | **否** — 直投  |
| 前端 HTTP        | `POST /api/messages/send` → `handleSendMessage` → `router.dispatch`| 是             |
| agent send_msg   | MCP 工具 → `CommServer.send` → `router.dispatch`                   | 是             |
| 系统通知代理     | `*.subscriber` → `buildEnvelope(system)` → `router.dispatch`       | 是             |

用户 WS prompt 直接注入 driver，agent 收到原文；其余入口走 `router.dispatch(env)` 三路分发。
