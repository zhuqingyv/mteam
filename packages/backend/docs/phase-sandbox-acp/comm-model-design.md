# mteam 通信模型设计文档 — 后端 + Agent 视角（Part A）

> 作者：架构师 A（后端 / Agent 侧）
> 对齐对象：架构师 B（前端 / Bus / UI）
> 适用阶段：Phase Sandbox-ACP — Stage 3 ~ Stage 5
> 代码锚点：`packages/backend/src/comm/*`、`packages/backend/src/mcp/*`、`packages/backend/src/bus/*`
>
> **受众分层**：
> - **§1 全景图 / §3 Agent 工具 / §4 持久化 / §5 Hub 流转 / §7 代码契合点**：**后端 + agent 实现者**专属。前端不消费、不实现。
> - **§2 MessageEnvelope 数据结构**：**前端 + 后端共享契约**，由后端 `comm/envelope.ts` 落盘，前端通过 `shared/types/envelope.ts` re-export 导入。
> - **§6 对 Part B（前端）的接口约定**：**前端消费契约**（HTTP 端点 + bus 事件 shape），前端按这里对齐。
> - **§3.1 send_msg inputSchema**：**面向 agent（MCP 工具）**，不是前端 API；前端发消息走 §6 的 HTTP `POST /api/messages/send`。
>
> **本文档只写”后端 + agent 侧”的部分**。前端 UI 展示、WS 订阅、bus 事件消费等内容在架构师 B 的 Part B。两份文档共享同一套 `MessageEnvelope` 数据结构（见 §2），这是前后端接口对齐的唯一契约。

---

## 0. 用户核心需求原文

为避免解读偏差，直接列出用户原话：

1. “每一个成员手中的 mteam mcp 都是一个通信设备”
   → 含义：mteam MCP 不是“业务工具集合”，而是一根**通信双工线**；工具只是动作语义的封装，底层在收发消息。
2. “他们怎么知道是 user 的信息，还是来自其他 agent 的信息？”
   → 含义：消息必须自带“来源身份”，且该身份要能区分 `user / agent / system`。
3. “我们是否能通过消息包装处理掉？”
   → 含义：不靠 prompt 约定、不靠前缀字符串，用**结构化 envelope** 在协议层解决。
4. “前端团队要分别出谁给谁发的消息”
   → 含义：envelope 里的 `from` / `to` 必须可直接渲染成“谁 → 谁”，不需要前端额外推断。
5. “agent 收到消息只看到通知：`@老王>报告做完了请查收`，想看详情主动调工具”
   → 含义：通过 driver.prompt 注入的内容是**仅带摘要的通知行**，全文必须是 agent 主动拉取（新增 `read_message` 工具）。

本文档所有设计必须可被以上 5 条原话直接验证。任何偏离都视为漂移。

---

## 1. 通信架构全景图

### 1.1 现状（代码中已有）

目前代码里消息流转的真实路径（基于 `comm/router.ts:50-105`、`comm/server.ts:138-147`、`mcp/comm-client.ts:109-123`、`mcp-http/in-process-comm.ts:33-49`）：

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           mteam MCP 通信通道（现状）                              │
└─────────────────────────────────────────────────────────────────────────────────┘

 Agent A (Claude/Codex 子进程)                       Agent B (Claude/Codex 子进程)
 ┌─────────────────────────┐                         ┌─────────────────────────┐
 │ driver.prompt(notify)   │◄────── (prompt 注入) ────┤                         │
 │ │                       │                         │ driver.prompt(notify)   │
 │ ▼ MCP tool call         │                         │ ▲                       │
 │ send_msg(to, sum, ctt)  │                         │ (formatMemberMessage)   │
 └──────────┬──────────────┘                         └─────────────────────────┘
            │  ① MCP stdio / HTTP                                 ▲
            ▼                                                     │ ⑤ driverDispatcher
 ┌─────────────────────────┐                         ┌─────────────────────────┐
 │ runSendMsg              │                         │ AgentDriver (B)         │
 │ (mcp/tools/send_msg.ts) │                         │ .prompt(text)           │
 └──────────┬──────────────┘                         └──────────▲──────────────┘
            │  ② CommLike.send                                   │
            ▼                                                    │
 ┌─────────────────────────┐                         ┌───────────┴─────────────┐
 │ CommClient              │  ── unix socket ──►     │ CommServer              │
 │   (stdio 模式)          │                         │   (net.createServer)    │
 │ 或                      │                         │                         │
 │ InProcessComm           │  ── 同进程 ──►          │ CommRouter.dispatch     │
 │   (HTTP 模式)           │                         │                         │
 └─────────────────────────┘                         └──────────┬──────────────┘
                                                                │ ③ parse addr
                                                                │ ④ 三叉：
                                                                │   a. local:system  → systemHandler
                                                                │   b. driverDispatcher.isReady → prompt
                                                                │   c. 有 socket 连接   → socket.write
                                                                │   d. 都没有           → offline.store (DB)
                                                                ▼
                                                     ┌─────────────────────────┐
                                                     │ messages 表（落库）      │
                                                     │ (comm/offline.ts)       │
                                                     └─────────────────────────┘
```

每一跳的代码位置：

| 跳 | 动作 | 代码 |
|----|------|------|
| ① | agent 调 `send_msg` | `packages/backend/src/mcp/tools/send_msg.ts:26` |
| ② | `CommLike.send` | `packages/backend/src/mcp/comm-client.ts:109` / `mcp-http/in-process-comm.ts:33` |
| ③ | `parseAddress(msg.to)` | `packages/backend/src/comm/protocol.ts:11` |
| ④ | `CommRouter.dispatch` 分支 | `packages/backend/src/comm/router.ts:50-105` |
| ⑤ | `driverDispatcher` → `driver.prompt` | `packages/backend/src/comm/driver-dispatcher.ts:7-18` |

**现状痛点**（本设计要修的）：
- agent 收到的是 `[来自 xxx] summary\n\ncontent` 字符串（`member-agent/format-message.ts:16-25`），没有结构；无法区分 `user / agent / system`。
- `send_msg` 的 `summary + content` 是两个 string 字段，没有 envelope 概念；前端若要渲染“谁给谁”，必须自己拼装。
- `check_inbox` 拉的是 HTTP `/api/role-instances/:id/inbox`，与 `comm/offline` 落库机制并存，两套路径没统一。
- agent 没有“先看通知、再按需拉全文”的机制，全文每次都被 formatMemberMessage 直接注入 prompt。

### 1.2 目标架构（本设计要落地的）

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      mteam 通信模型 · 目标架构 (Stage 3 后)                       │
└─────────────────────────────────────────────────────────────────────────────────┘

                        [User 在前端 UI 输入消息]
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  前端 Web UI (Part B 负责)                                                    │
│   POST /api/messages/send  body: { from:{kind:'user',...}, to:{...}, ... }    │
└──────────────────────────┬───────────────────────────────────────────────────┘
                           │ (a) HTTP
                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Hub Process (Node)                                                           │
│                                                                               │
│   ┌──────────────┐   ┌──────────────┐   ┌────────────────────────────────┐  │
│   │ /api/messages│   │ CommLike.send│   │ mcp/tools/send_msg.ts          │  │
│   │   (HTTP in)  │   │  (各 agent   │   │   + read_message / check_inbox │  │
│   │              │   │   stdio in)  │   │                                │  │
│   └──────┬───────┘   └──────┬───────┘   └───────────────┬────────────────┘  │
│          │                  │                           │                    │
│          └──────────────────┴───────────────────────────┘                    │
│                             │                                                │
│                             ▼                                                │
│          ┌──────────────────────────────────────────┐                        │
│          │  EnvelopeBuilder (新增)                   │                        │
│          │   - from.kind 强注入（防伪造）             │                        │
│          │   - 生成 envelope.id (uuid)               │                        │
│          │   - 填 ts / team_id / reply_to            │                        │
│          └──────────────────┬───────────────────────┘                        │
│                             │ MessageEnvelope                                │
│                             ▼                                                │
│          ┌──────────────────────────────────────────┐                        │
│          │  MessageStore (新增，包 messages 表)      │                        │
│          │   - insert → 返回 db id                  │                        │
│          │   - envelope.id = `msg_${dbId}` 或 uuid │                        │
│          └──────────────────┬───────────────────────┘                        │
│                             │                                                │
│                             ▼                                                │
│          ┌──────────────────────────────────────────┐                        │
│          │  CommRouter.dispatch(envelope)           │                        │
│          │   + 同时向 bus 发 comm.message_sent       │                        │
│          │      / comm.message_received             │                        │
│          └──────────────────┬───────────────────────┘                        │
│                             │                                                │
│     ┌───────────────────────┼─────────────────────────────┐                  │
│     ▼                       ▼                             ▼                  │
│  local:system        driverDispatcher              offline.store            │
│  (systemHandler)     → driver.prompt(notifyLine)   (pending)                │
│                         ↑                                                   │
│                    notifyLine = `@<from_display>>${summary}`                │
└──────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
              Agent B 只看到一行通知（notify line）；
              若要看全文，主动调 read_message(messageId)。
```

### 1.3 四种发送方向汇总

| # | 方向 | 入口 | 强注入的 from | 负责处理的模块 |
|---|------|------|--------------|---------------|
| 1 | **agent A → agent B**（本机） | `send_msg` 工具 | `{ kind:'agent', instanceId, memberName }` | CommLike → CommRouter → driverDispatcher |
| 2 | **user → agent**（前端） | `POST /api/messages/send` | `{ kind:'user', userId }`（由会话 session 注入） | HTTP handler → EnvelopeBuilder → CommRouter |
| 3 | **system → agent**（系统通知） | bus subscriber 内部调用 `CommRouter.dispatch` | `{ kind:'system', source }` | bus subscriber → CommRouter |
| 4 | **跨机 agent → agent**（Phase 2 预留） | 远程 hub 转发 | 远端 hub 注入后再转本机 | 本阶段仅在 router 识别 `scope!='local'` 时打印 warn，不实装 |

方向 4 走 `CommRouter.dispatch` 已有的 `scope !== 'local'` 分支（`router.ts:59-65`），本设计**不扩展**，只保留占位字段 `envelope.from.origin?: 'remote'` 供 Phase 2 使用。

---

## 2. MessageEnvelope 数据结构

> **面向**：**前端 + 后端共享契约**。后端实现落在 `packages/backend/src/comm/envelope.ts`；前端通过 `shared/types/envelope.ts` 导入同一套类型，不重复定义。

### 2.1 完整 TypeScript 定义

拟落盘位置：`packages/backend/src/comm/envelope.ts`（新文件）。

```typescript
// mteam 通信模型核心数据结构。
// 前后端、agent 内外、bus 事件、DB 持久化都用这一套 envelope。
// 不要在 router / tool / bus 任何一层“脱壳”成散字段再传。

/** 发送/接收方的结构化身份。any agent tool / UI / subscriber 必须用这个而不是裸字符串。 */
export interface ActorRef {
  /** 身份大类 —— 回答“这条消息是谁发的”。 */
  kind: 'user' | 'agent' | 'system';

  /**
   * 稳定地址：与 comm/protocol.ts 的 `Address` 一致。
   *   user:   `user:<userId>` 或 `user:local`（单用户场景）
   *   agent:  `local:<instanceId>`（本机）/ `remote:<hubId>:<instanceId>`（Phase 2）
   *   system: `local:system`
   * 这是 CommRouter 真正用来路由的字段。
   */
  address: string;

  /** 仅用于 UI 展示 / 通知行拼装的“可读名字”。不参与路由。 */
  displayName: string;

  /** agent 专用：对应 role_instances.id。user/system 为 null。 */
  instanceId?: string | null;

  /** agent 专用：对应 role_instances.member_name。user/system 为 null。 */
  memberName?: string | null;

  /** Phase 2 预留：消息是否来自远端 hub。本期值恒为 'local'，不做校验。 */
  origin?: 'local' | 'remote';
}

/** 消息种类 —— 控制 UI 渲染、通知样式、落库语义。 */
export type MessageKind = 'chat' | 'task' | 'broadcast' | 'system';

/** 完整信封：发送端生成 → 路由端路由 → 接收端消费 → 落库。全流程只传这一个对象。 */
export interface MessageEnvelope {
  /** 全局唯一。UUID 或 `msg_${dbId}`，DB 写入后两者等价。 */
  id: string;

  /** 发送方（已被 EnvelopeBuilder 强注入，不信任调用方传入的 kind）。 */
  from: ActorRef;

  /** 接收方（由 lookup / address 解析得到）。 */
  to: ActorRef;

  /** 团队 id。跨团队消息保留为 null。 */
  teamId: string | null;

  /** 消息种类。默认 `chat`。 */
  kind: MessageKind;

  /** 摘要。必填 —— agent 通知行、UI inbox 列表、search 索引都依赖这一字段。 */
  summary: string;

  /** 全文。可选：纯 system 通知可以只有 summary。 */
  content?: string;

  /** 回复哪一条消息。null 表示新开话题。 */
  replyTo: string | null;

  /** 消息生成时间（ISO 8601）。由 EnvelopeBuilder 统一注入。 */
  ts: string;

  /** agent 读取/标记已读的时间；未读为 null。落库字段对应 messages.read_at。 */
  readAt: string | null;

  /**
   * 可选的结构化附件。本期不强约束 schema，前端渲染白名单 [file, link, table]。
   * 不要把附件正文塞进 content，附件二进制走独立上传再引用。
   */
  attachments?: Array<{ type: string; [k: string]: unknown }>;
}
```

### 2.2 字段说明表（MessageEnvelope）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 全局唯一；DB 行写入成功后为 `msg_${dbId}`，前端可直接作为 React key。不允许前端/agent 自行生成。 |
| `from` | `ActorRef` | 是 | 发送方。`kind` 在 EnvelopeBuilder 里按入口强注入（HTTP 入口只能是 `user`，MCP 工具入口只能是 `agent`，bus 内部调用只能是 `system`）—— **防伪造核心**。 |
| `to` | `ActorRef` | 是 | 接收方。由 `send_msg.to` 经 `lookup` 解析得到 `address`，再从 `role_instances` 反查 `instanceId / memberName / displayName`。 |
| `teamId` | `string \| null` | 是 | 对应 `teams.id`。`from`/`to` 任一不在团队，或跨团队系统消息，置 null。 |
| `kind` | `'chat' \| 'task' \| 'broadcast' \| 'system'` | 是 | 默认 `chat`。值域对齐 `messages.kind` CHECK 约束（已有：`messages.sql:11`）。 |
| `summary` | `string` | 是 | ≤ 200 字（发送端强约束）。通知行只展示这一字段 —— `@<displayName>>${summary}`。 |
| `content` | `string` | 否 | 消息全文。agent 调 `read_message` 时才返回。允许为空字符串（纯通知）。 |
| `replyTo` | `string \| null` | 是 | 指向另一条 envelope 的 id。前端用它画 thread。 |
| `ts` | `string` | 是 | ISO 8601 UTC。EnvelopeBuilder 注入，调用方不能改。 |
| `readAt` | `string \| null` | 是 | 未读为 null；`check_inbox` / `read_message` 触发写入。 |
| `attachments` | `Array<...>` | 否 | 可省略；本期不做校验，仅透传给前端。 |

### 2.3 ActorRef 字段说明表

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `kind` | `'user' \| 'agent' \| 'system'` | 是 | 回答用户需求 #2 的核心字段。 |
| `address` | `string` | 是 | 必须通过 `parseAddress` 校验（`comm/protocol.ts:11`）。格式 `<scope>:<id>`。 |
| `displayName` | `string` | 是 | UI / 通知行唯一可读文案。user 默认 `"User"`，system 默认 `"系统"`，agent 取 `role_instances.member_name`（带 alias 时优先 alias）。 |
| `instanceId` | `string \| null` | 否 | agent 专用。对应 `role_instances.id`。user / system 不填或 null。 |
| `memberName` | `string \| null` | 否 | agent 专用。即角色模板中的 `member_name`。 |
| `origin` | `'local' \| 'remote'` | 否 | Phase 2 预留，默认 `'local'`。 |

### 2.4 为什么用 Envelope 而不是沿用 `Message.payload`

现状 `comm/types.ts:14-21` 定义的 `Message.payload` 是 `Record<string, unknown>`，这让：
- `router.ts:26-32` 的 `extractText` 用字符串拼接取 summary/content；
- `format-message.ts:16` 按 `kind === 'system'` 做分支；
- `offline.ts:28-39` 把整个 payload 再 `JSON.stringify` 塞进 `messages.content`；

都成为脆弱耦合 —— 任何新字段（如 `replyTo`、`attachments`）都要在 4 处同步改。Envelope 以**类型定义**一次性固定结构，后续所有层只 `import type { MessageEnvelope }`，编译期强制对齐。

---

## 3. Agent 侧通信

> ⛔ **服务端底层接口（MCP 工具），禁止前端调用**
>
> **面向**：**后端实现者** + **agent（MCP 工具调用方）**。
> **非面向**：前端。前端发消息不调 MCP 工具，走 §6 的 HTTP `POST /api/messages/send`。

### 3.1 `send_msg` 工具（改造）

当前定义：`packages/backend/src/mcp/tools/send_msg.ts:5-19`。

改造要点：
- `summary` 改为可选；缺省时 hub 填入 `"给你发了一条消息"`。
- 新增可选 `kind`（默认 `chat`）。
- 新增可选 `replyTo`（指向已有 envelope id）。
- 返回值从 `{ delivered, to }` 扩展为 `{ messageId, envelope }`，让调用方可以直接引用。
- 调用方传入的任何 `from` 字段**都忽略** —— `from` 由 `CommLike.send` 根据 `selfAddress` 强注入。

新 inputSchema：

```typescript
export const sendMsgSchema = {
  name: 'send_msg',
  description:
    'Send a message to another actor (agent / user / system). Message body is wrapped in a MessageEnvelope; your identity (from) is injected by the hub. Returns messageId, which others can use via read_message.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: {
        type: 'string',
        description: 'Target: address (local:<id>), alias, member_name, or instanceId. Multiple matches → error.',
      },
      summary: {
        type: 'string',
        maxLength: 200,
        description: 'Short summary (≤ 200 chars). Shown to recipient as `@<you>>${summary}`. Optional; default "给你发了一条消息".',
      },
      content: {
        type: 'string',
        description: 'Full message body. Recipient must call read_message to see this.',
      },
      kind: {
        type: 'string',
        enum: ['chat', 'task', 'broadcast'],
        default: 'chat',
        description: 'Message kind. `system` is NOT allowed from agent tools — system messages are hub-internal only.',
      },
      replyTo: {
        type: 'string',
        description: 'Envelope id of the message you are replying to. Optional.',
      },
    },
    required: ['to', 'content'],
    additionalProperties: false,
  },
};
```

返回值：

```typescript
// 成功
{ delivered: true, messageId: 'msg_123', route: 'local-online' | 'local-offline' | 'system' }
// 失败
{ error: string }
```

**设计不变项**：
- `to` 解析逻辑保留（`send_msg.ts:38-50`）：既支持 address 也支持 alias/member_name 的 lookup。
- `leaderOnly=false` 保留（`registry.ts:48`）—— 所有 agent 都能发。

### 3.2 `read_message` 工具（新增）

这是回应用户需求 #5 的核心 —— agent 通知行里只看到摘要，要看全文必须显式调工具。

拟落盘位置：`packages/backend/src/mcp/tools/read_message.ts`。

```typescript
export const readMessageSchema = {
  name: 'read_message',
  description:
    'Fetch the full MessageEnvelope by id. Call this when you see a notification line `@<name>>${summary}` and want the full content.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      messageId: {
        type: 'string',
        description: 'The envelope id you received in a notification line. Format: `msg_<number>` or uuid.',
      },
      markRead: {
        type: 'boolean',
        default: true,
        description: 'If true (default), this call also marks the message as read.',
      },
    },
    required: ['messageId'],
    additionalProperties: false,
  },
};

export async function runReadMessage(
  env: MteamEnv,
  args: { messageId?: unknown; markRead?: unknown },
): Promise<
  | { envelope: MessageEnvelope }
  | { error: string }
>;
```

返回值：

| 字段 | 类型 | 说明 |
|------|------|------|
| `envelope` | `MessageEnvelope` | 完整信封（见 §2.1）。`readAt` 反映本次调用后的最新状态。 |

约束：
- 只允许查收件人 = 当前 `env.instanceId` 的消息；否则 `403`。
- 已被删除（`role_instances` CASCADE）的消息返回 `404`。
- `markRead=true` 时走 `UPDATE messages SET read_at = now WHERE id = ? AND read_at IS NULL`（同 `offline.ts:84-90` 但无条件），避免重复触发 UI 未读角标。

### 3.3 `check_inbox` 工具（调整）

当前定义：`packages/backend/src/mcp/tools/check_inbox.ts:4-19`。

改造要点：保留工具，但**只返回摘要列表，不含 content**。
- `peek` 参数保留。
- 返回值字段对齐 Envelope 子集：`[{ id, from, summary, kind, ts, replyTo }, …]`。
- 具体全文要用 `read_message(id)` 拉。
- 语义上 `check_inbox` = “我有哪些未读”，`read_message` = “读其中一条的全文”。两者职责分离。

新返回结构：

```typescript
interface InboxSummary {
  id: string;                 // envelope id
  from: ActorRef;             // 摘要也需要，UI / agent 要能说“来自谁”
  summary: string;
  kind: MessageKind;
  replyTo: string | null;
  ts: string;
  readAt: string | null;      // peek=true 时全为 null（未改）；peek=false 后为本次时间戳
}

interface InboxResponse {
  messages: InboxSummary[];
  total: number;              // = messages.length
}
```

**是否保留**？保留。理由：
1. agent 启动时的回灌（`bus/subscribers/member-driver/replay.ts:50`）是**自动推送**；`check_inbox` 是 agent **自主拉取**（例如 agent 刚 prompt 完一轮想主动看“这段时间有没有漏的消息”）。
2. 前端也会复用这个 endpoint 渲染角色侧的收件箱面板（Part B 里 B 会讨论）。

### 3.4 Agent 收到通知的格式（通过 driver.prompt 注入）

替换当前 `format-message.ts:16-25` 的实现。

**唯一规则**：driver.prompt 注入的文本只有**一行**，格式固定：

```
@<from.displayName>>${summary}  [msg_id=<envelope.id>]
```

示例：

```
@老王>报告做完了请查收  [msg_id=msg_1423]
@User>帮我分析下这个 PR  [msg_id=msg_1424]
@系统>你已被踢出团队  [msg_id=msg_1425]
```

三个 kind 的显示差异**仅在 displayName**：
- `kind === 'user'` → `displayName = "User"`（前端可自定义）
- `kind === 'agent'` → `displayName = role_instances.member_name`（或 alias）
- `kind === 'system'` → `displayName = "系统"`

**不在通知行里写 `content`**。任何需要上下文的信息，agent 都必须调 `read_message(msg_id)` 拿到 envelope 才能用。这是硬约束 —— 让 agent 以“人读消息”的方式工作：先扫摘要，再按需拉全文。

实现位置：改 `packages/backend/src/member-agent/format-message.ts`：

```typescript
// 新签名（替换现有）
export interface FormatNotifyInput {
  envelopeId: string;
  fromDisplayName: string;
  summary: string;
}

export function formatNotifyLine(input: FormatNotifyInput): string {
  return `@${input.fromDisplayName}>${input.summary}  [msg_id=${input.envelopeId}]`;
}
```

原有 `formatMemberMessage` 保留一个 shim（内部 delegate 到 `formatNotifyLine`）以免 `bus/subscribers/member-driver/replay.ts:60` 一次性改不动；shim 在 Stage 3 落地后的下一个 PR 删除。

### 3.5 工具注册表更新

改 `packages/backend/src/mcp/tools/registry.ts:34-75`：

```typescript
export const ALL_TOOLS: ToolEntry[] = [
  // ...
  { schema: sendMsgSchema,      handler: /* unchanged wiring */, leaderOnly: false },
  { schema: checkInboxSchema,   handler: /* unchanged wiring */, leaderOnly: false },
  { schema: readMessageSchema,  handler: ({ env }, args) => runReadMessage(env, args), leaderOnly: false },
  // ...
];
```

三件套全部 `leaderOnly: false` —— 普通成员和 leader 都能收发/查看消息。

---

## 4. 消息持久化

> ⛔ **服务端底层接口（DB schema / MessageStore），禁止前端调用**
>
> **面向**：**后端实现者**（DB 迁移 / MessageStore）。前端不直接访问 SQL，通过 §6 的 HTTP 接口查消息。

### 4.1 `messages` 表（扩列）

现有 schema 在 `packages/backend/src/db/schemas/messages.sql:5-17`。扩列后：

```sql
-- ============================================================
-- 9. messages —— 实例间通信 (v2)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,

  -- v1 已有
  from_instance_id TEXT REFERENCES role_instances(id) ON DELETE SET NULL,
  to_instance_id   TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  team_id          TEXT REFERENCES teams(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL DEFAULT 'chat'
                   CHECK(kind IN ('chat','task','broadcast','system')),
  summary          TEXT NOT NULL DEFAULT '',
  content          TEXT NOT NULL,
  sent_at          TEXT NOT NULL,
  read_at          TEXT,
  reply_to_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,

  -- v2 新增
  from_kind        TEXT NOT NULL DEFAULT 'agent'
                   CHECK(from_kind IN ('user','agent','system')),
  from_user_id     TEXT,                                -- 仅 from_kind='user' 时有值
  from_display     TEXT NOT NULL DEFAULT '',            -- 发送时即冻结的 displayName
  to_kind          TEXT NOT NULL DEFAULT 'agent'
                   CHECK(to_kind IN ('user','agent','system')),
  to_display       TEXT NOT NULL DEFAULT '',            -- 同上，接收方 displayName
  envelope_uuid    TEXT NOT NULL UNIQUE,                -- 对外暴露的 envelope.id
  attachments_json TEXT                                 -- attachments 序列化，null 表示空
);

CREATE INDEX IF NOT EXISTS idx_msg_to_unread
  ON messages(to_instance_id, sent_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_msg_to       ON messages(to_instance_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_from     ON messages(from_instance_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_team     ON messages(team_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_reply    ON messages(reply_to_id);
CREATE INDEX IF NOT EXISTS idx_msg_env_uuid ON messages(envelope_uuid);       -- read_message 查询
CREATE INDEX IF NOT EXISTS idx_msg_from_kind ON messages(from_kind, sent_at DESC); -- UI 按来源筛
```

**迁移策略**：
- 上述 `ALTER TABLE ADD COLUMN` 可逐列加，SQLite 支持。
- 历史数据：`from_kind` 默认值 `'agent'`；若 `from_instance_id IS NULL` 则 backfill 为 `'system'`。
- `envelope_uuid` 需 backfill：`UPDATE messages SET envelope_uuid = 'msg_' || id WHERE envelope_uuid IS NULL;`
- `from_display` / `to_display` 可 backfill 为空字符串（UI 降级处理 `"(未知)"`）。

### 4.2 字段语义

| 列 | 与 Envelope 的映射 |
|----|-------------------|
| `envelope_uuid` | `envelope.id` |
| `from_kind` | `envelope.from.kind` |
| `from_instance_id` | `envelope.from.instanceId` (kind=agent) |
| `from_user_id` | `envelope.from.address` 去 `user:` 前缀 (kind=user) |
| `from_display` | `envelope.from.displayName` |
| `to_kind` / `to_instance_id` / `to_display` | 对称 |
| `team_id` | `envelope.teamId` |
| `kind` | `envelope.kind` |
| `summary` | `envelope.summary` |
| `content` | `envelope.content`（可能为空字符串） |
| `sent_at` | `envelope.ts` |
| `read_at` | `envelope.readAt` |
| `reply_to_id` | 用 `envelope.replyTo` 反查内部 `id` |
| `attachments_json` | `JSON.stringify(envelope.attachments)` |

### 4.3 写入时机

**统一入口**：`MessageStore.insert(envelope)` 在 `CommRouter.dispatch` 的**最开始**调用，晚于 EnvelopeBuilder、早于所有路由分支。

原因：
1. 落库要先于路由，这样**不管**路由结果是 online / offline / dropped，消息都有一条可以被 `check_inbox` / `read_message` 查到的记录。
2. `offline.store`（`comm/offline.ts:24`）当前只在“对方不在线”时写库，与 online 分支不对称；改造后统一写入，offline 分支只多做一步“记录 pending 状态”。

写入位置：改 `router.ts:50-105`：

```typescript
async dispatch(msg: MessageEnvelope): Promise<DispatchOutcome> {
  // 1. 先落库（不管后续路由结果）
  const dbId = this.messageStore.insert(msg);
  const stamped: MessageEnvelope = { ...msg, id: `msg_${dbId}` };

  // 2. bus 发 comm.message_sent（给 Part B 的前端订阅用）
  bus.emit({ ...makeBase('comm.message_sent', 'comm/router'), messageId: stamped.id, from: stamped.from.address, to: stamped.to.address });

  // 3. 按现有 scope / system / driver / socket / offline 分支路由
  //    online 分支里 driver.prompt(notifyLine) 使用 stamped.id
  //    offline 分支仅记 pending，不再重复 store
  // ...
}
```

返回给 `send_msg` 调用方的 `messageId` 就是 `stamped.id`。

---

## 5. Hub 消息流转详细步骤

> ⛔ **服务端底层实现，禁止前端调用**
>
> **面向**：**后端实现者**。全链路 11 步说的是 hub 进程内部流转，前端只看 §6 的入口。

以 **agent A 发给 agent B** 为例，完整 11 步：

1. **Agent A（Claude 子进程）** 决定发消息，产出 MCP tool call：`send_msg({ to: "老王", summary: "报告做完了", content: "...", kind: "chat" })`。

2. **MCP 层**（`mcp/tools/send_msg.ts:26 runSendMsg`）校验：
   - `to` 非空 → 走 `runLookup({ query: "老王" })`（`tools/lookup.ts`）→ 返回 `{ match: 'single', target: { address: 'local:inst_42', ... } }`。
   - `summary` 可选，缺省填默认。

3. **工具层**调 `comm.send({ to: 'local:inst_42', payload: { summary, content, kind, replyTo } })`。
   - 此处 `comm` 是注入到 `ToolDeps` 的 `CommLike` 实例（`mcp/tools/registry.ts:18-21`）。stdio 模式是 `CommClient`（`mcp/comm-client.ts:13`），HTTP 模式是 `InProcessComm`（`mcp-http/in-process-comm.ts:19`）。
   - 关键：**`from` 由 `CommLike.send` 自己从 `selfAddress` 注入**（`comm-client.ts:113-116` / `in-process-comm.ts:37`），调用方没法伪造。

4. **CommLike.send** 构造底层 `Message`（`comm/types.ts:14-21`）并发往 hub：
   - stdio 模式：socket.write → `CommServer.onData → handleLine`（`comm/server.ts:98-147`）。
   - HTTP 模式：直接调 `router.dispatch(msg)`（`in-process-comm.ts:42`）。

5. **EnvelopeBuilder**（新增，插入在 `router.dispatch` 入口）把底层 `Message` 翻译成 `MessageEnvelope`：
   - `from.kind = 'agent'`（强注入，因为 `Message` 是 MCP 工具入口来的）；从 `role_instances` 表查 `instanceId = parseAddress(msg.from).id`，拿到 `memberName` / alias → `displayName`。
   - `to` 同理。
   - `ts = msg.ts`，`kind = payload.kind ?? 'chat'`，`replyTo = payload.replyTo ?? null`，`teamId` 查 `team_members` 表。
   - `id` 先空，待落库后填。

6. **MessageStore.insert(envelope)** 写 `messages` 表（§4.3）。返回 `dbId`，回填 `envelope.id = 'msg_' + dbId`。

7. **bus.emit `comm.message_sent`**（`bus/types.ts:99-104`，现有事件，字段对齐）。Part B 前端的 SSE 订阅会从这里拿到“有新消息写入”的通知。

8. **CommRouter 路由**（`router.ts:50-105`，基本逻辑不变，只是改吃 envelope）：
   - `parseAddress(envelope.to.address)`；scope != 'local' → `remote-unsupported`（Phase 2 预留）。
   - id === 'system' → `systemHandler(envelope)` → `{ route: 'system' }`。
   - 否则走 `driverDispatcher(id, notifyLine)`。

9. **driverDispatcher**（`comm/driver-dispatcher.ts:7-18`）：
   - 查 `driverRegistry.get(instanceId)`。不存在 → `not-found`。
   - 存在但 `isReady() === false` → `not-ready`。
   - 以上两种情况 fallthrough 到下一分支。
   - 若 ready：调 `driver.prompt(notifyLine)`（`agent-driver/driver.ts:62-78`）→ 返回 `'delivered'`。
   - **改造点**：入参从 `text` 改为 `(envelopeId, fromDisplayName, summary)`，由 dispatcher 内部 `formatNotifyLine(...)`（§3.4）拼接通知行，避免 router 再碰具体文案。

10. **Agent B 的 Claude 进程**通过 ACP 协议收到 prompt，走正常 turn：
    - 看到 prompt 里多了一行 `@老王>报告做完了  [msg_id=msg_1423]`。
    - 如果 B 需要全文，它会在 turn 里调 `read_message({ messageId: "msg_1423" })`。
    - `runReadMessage(env, args)` → `GET /api/messages/msg_1423`（或直接查 DB）→ 返回完整 envelope → 标记 `read_at=now`。

11. **bus.emit `comm.message_received`**（`bus/types.ts:106-112`）在 step 9 的 `delivered` 分支里发出。Part B 的 UI 订阅这个事件刷新未读角标。

离线分支（step 9 返回 `not-ready` / `not-found`）：
- 落库在 step 6 已完成，无需二次存储。
- 不触发 `comm.message_received`。
- 等 agent B 上线（`instance.activated` 事件），走 `bus/subscribers/member-driver/replay.ts:50 replayForDriver`：从 `messages` 表取所有 `to_instance_id=B AND read_at IS NULL` → 逐条 `driver.prompt(notifyLine)` → 成功后 `markDelivered`。

系统消息分支（`envelope.from.kind === 'system'`）：
- step 5 由 bus subscriber 在内部调 `commRouter.dispatch(envelope)`，而不是经 MCP 工具入口。
- EnvelopeBuilder 此时读 `envelope.from.kind === 'system'` 并放行（唯一允许 system 的入口）。
- step 10 的 agent 看到的通知行是 `@系统>${summary}  [msg_id=...]`，一眼可区分（回应用户需求 #2）。

User → Agent 分支（`envelope.from.kind === 'user'`）：
- step 3 不经 `send_msg` 工具，而是 `POST /api/messages/send`（HTTP in）。
- HTTP handler 从当前前端 session 拿到 `userId`，强注入 `from.kind = 'user'`。
- 之后的 step 5 ~ step 11 与 agent 发送完全相同。
- 通知行：`@User>${summary}  [msg_id=...]`。

---

## 6. 对 Part B（前端）的接口约定

下面是我承诺提供给 B 的接口；B 的文档必须吃这套，不要在 B 侧重新定义。

1. **核心类型**：`packages/backend/src/comm/envelope.ts` 导出 `MessageEnvelope` / `ActorRef` / `MessageKind`。B 的前端从 `packages/shared/types/envelope.ts`（由我在实现阶段把这三项 re-export 过去）导入。
2. **HTTP 入口**：
   - `POST /api/messages/send` body: `Pick<MessageEnvelope, 'to' | 'summary' | 'content' | 'kind' | 'replyTo' | 'attachments'>`（注意**没有** `from`）；响应 `{ messageId }`。
   - `GET /api/messages/:id` 响应 `{ envelope: MessageEnvelope }`。
   - `GET /api/role-instances/:id/inbox?peek=true` 响应 `{ messages: InboxSummary[], total: number }`。
3. **bus 事件**：`comm.message_sent` / `comm.message_received`（均已在 `bus/types.ts:99-112` 定义，字段不变）。新增字段 `envelopeId?: string` → 第一版可以不填，Part B 若需要请直接来对齐。
4. **强注入约束**：后端保证 HTTP 入口的 envelope 一定带 `from.kind === 'user'`，MCP 入口一定带 `from.kind === 'agent'`，bus 内部一定带 `from.kind === 'system'`。B 的 UI 可以用 `from.kind` 切换渲染，不需要自己重新推断。

---

## 7. 与现有代码的契合点 / 回退清单

| 改动 | 现有文件 | 影响 |
|------|---------|------|
| 新增 `comm/envelope.ts` | - | 纯增，零回退。 |
| 改 `comm/router.ts` `dispatch` 入参从 `Message` → `MessageEnvelope` | `router.ts:50-105` | `server.ts:139`、`in-process-comm.ts:42`、`replay.ts` 调用点同步改。 |
| 新增 `MessageStore` 模块 | - | 替换 `offline.store()` 中的 INSERT，`replayFor` 保留只读逻辑。 |
| 扩列 `messages` 表 | `db/schemas/messages.sql:5-17` | ALTER TABLE + backfill 迁移（§4.1）。 |
| `send_msg` 参数 / 返回值调整 | `mcp/tools/send_msg.ts` | `registry.ts:46-49` 不用动；测试要同步改。 |
| 新增 `read_message` 工具 | - | `registry.ts:34` 加一条。 |
| `check_inbox` 返回 shape 调整 | `mcp/tools/check_inbox.ts`、`api/role-instances.ts` | 前端同步。 |
| 替换 `formatMemberMessage` → `formatNotifyLine` | `member-agent/format-message.ts`、`bus/subscribers/member-driver/replay.ts:60` | 保留 shim 过渡一版。 |

**回退策略**：
- 表扩列全部允许 NULL，迁移可回退。
- 工具改造通过 schema 的 `required` 收缩，旧客户端传 `summary + content` 依然可用（summary 仍是可选字段）。
- EnvelopeBuilder / MessageStore 如需 rollback，只需把 `dispatch` 参数类型还原为 `Message`，其余模块保持冻结接口（见 `INTERFACE-CONTRACTS.md` §5 修改流程）。

---

## 8. 对齐校验清单（用户需求 → 设计）

| 用户需求 | 本设计对应的落点 |
|---------|----------------|
| “mteam mcp 是通信设备” | §1 全景图 / §3 工具三件套（send / read / inbox）作为设备的 I/O 接口。 |
| “怎么区分 user / agent / system” | §2.1 `ActorRef.kind` + §4 `messages.from_kind` + §3.4 通知行的 `displayName`。 |
| “通过消息包装处理” | §2 `MessageEnvelope` 作为全链路唯一载体；§5 step 5 EnvelopeBuilder 强注入 `from.kind`。 |
| “前端分清谁发给谁” | §2.2 envelope `from` / `to` 都是 `ActorRef`，含 `kind + displayName + address`，前端直接渲染。 |
| “agent 只看 `@名字>摘要`，要看详情主动调工具” | §3.4 `formatNotifyLine` + §3.2 `read_message`。 |

---

## 9. 变更日志

| 日期 | 改动 | 作者 |
|------|------|------|
| 2026-04-25 | 初版（Part A：后端 + Agent 视角） | 架构师 A |
