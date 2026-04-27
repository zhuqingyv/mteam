# mteam 通信模型设计文档 — 前端 API + WebSocket 视角（Part B）

> 作者：架构师 B（前端 / UI / bus 订阅）
> 配套：架构师 A 的 Part A（`/Users/zhuqingyu/project/mcp-team-hub/docs/phase-sandbox-acp/comm-model-design.md`）
> 共享契约：`MessageEnvelope` / `ActorRef` / `MessageKind`（见 Part A §2.1 和本文件 §8）
>
> **本文档只写「前端 UI / 实时推送 / HTTP 查询」**。Envelope 数据结构、EnvelopeBuilder、MessageStore、工具层改造、messages 表扩列，全部以 Part A 为准；本文件直接吃 A 的契约，不重复定义，不偏离。
>
> 核心用户需求（与 Part A §0 共享）：
> 1. 前端必须能分辨**每条消息是谁发给谁的**。
> 2. 需要渲染成**多方聊天界面** — 谁→谁、何时、什么类型。
> 3. 需要**实时推送 + 历史查询**双通道。

---

## 第六部分：前端实时推送（WebSocket）

### 6.1 WS 连接与事件总览

| 项 | 值 |
|---|---|
| 连接地址 | `ws://<host>:<port>/ws/events` |
| 升级入口 | `packages/backend/src/bus/ws-upgrade.ts` |
| 广播器 | `packages/backend/src/bus/subscribers/ws.subscriber.ts` |
| 订阅模型 | 白名单全量推送，前端按事件 `type` / 内容字段自行过滤 |
| 剥离字段 | `source`、`correlationId`（内部字段，前端无需） |

### 6.2 沿用 Part A 既定的 bus 事件（不新增事件类型）

本期**不新增** bus 事件类型，**完全沿用** `bus/types.ts:99-112` 的两个事件（字段 0 改动）：

| 事件 type | 字段 | 何时推 |
|---|---|---|
| `comm.message_sent` | `messageId`, `from`, `to` | router 落库成功后立即推 |
| `comm.message_received` | `messageId`, `from`, `to`, `route` | driverDispatcher 成功把通知行交付到 agent 后推 |

> 两个事件均已在 `WS_EVENT_TYPES` 白名单内（`ws.subscriber.ts:19-20`），无需扩白名单。

### 6.3 前端拿到事件后的典型流程

由于 bus 事件只带 `messageId`，不带完整 envelope，前端在收到 WS 推送后需要二次查询：

```
┌────────────────────┐          ┌─────────────────────┐
│ WS /ws/events      │  推送     │ comm.message_sent   │
│ (订阅)             ├──────────►│ { messageId, from,  │
│                    │           │   to }              │
└────────────────────┘           └──────────┬──────────┘
                                             │
                                             ▼
                               ┌───────────────────────────┐
                               │ 前端 store 检查是否已缓存 │
                               │   envelope(messageId)?    │
                               └────────┬──────────┬───────┘
                                   已缓存│        │未缓存
                                        ▼        ▼
                             ┌──────────────┐  ┌──────────────────────┐
                             │ 直接更新 UI  │  │ fetch                │
                             │              │  │ GET /api/messages/:id│
                             └──────────────┘  └──────────┬───────────┘
                                                           ▼
                                              ┌─────────────────────┐
                                              │ 拿到完整 envelope，  │
                                              │ 插入 store，渲染 UI │
                                              └─────────────────────┘
```

**为什么不直接在 WS 推 envelope？**
Part A §6 明确：**不加 `envelopeId` 字段也不扩 payload，messageId 反查一次**。优点是 bus 事件结构冻结、订阅者 schema 稳定；代价是前端每条新消息多一次 HTTP。对于聊天 UI 体量完全能接受（一次轻量 GET，结果可永久缓存）。

**替代方案（若性能问题）**：未来可在 WS 侧新增一个 subscriber（不是新 bus 事件），专门监听 `comm.message_sent` → 反查 envelope → 以 `comm.envelope_delivered`（仅 WS 层）推给前端。本期先不做，先用「WS 通知 + HTTP 拉取」方案。

### 6.4 WS 推送数据示例

#### 示例 1：`comm.message_sent`（消息已落库）

```json
{
  "type": "comm.message_sent",
  "ts": "2026-04-25T10:32:18.431Z",
  "messageId": "msg_1423",
  "from": "local:inst_backend_01",
  "to": "local:inst_frontend_01"
}
```

#### 示例 2：`comm.message_received`（消息送达 agent）

```json
{
  "type": "comm.message_received",
  "ts": "2026-04-25T10:32:18.620Z",
  "messageId": "msg_1423",
  "from": "local:inst_backend_01",
  "to": "local:inst_frontend_01",
  "route": "driver"
}
```

#### 示例 3：前端二次查询后拿到的完整 envelope

```
GET /api/messages/msg_1423
```

```json
{
  "envelope": {
    "id": "msg_1423",
    "from": {
      "kind": "agent",
      "address": "local:inst_backend_01",
      "displayName": "后端A",
      "instanceId": "inst_backend_01",
      "memberName": "backend",
      "origin": "local"
    },
    "to": {
      "kind": "agent",
      "address": "local:inst_frontend_01",
      "displayName": "前端B",
      "instanceId": "inst_frontend_01",
      "memberName": "frontend",
      "origin": "local"
    },
    "teamId": "team_01HX8A0QWERTYU",
    "kind": "chat",
    "summary": "接口字段确认",
    "content": "MessageEnvelope.from 字段我已经改成 ActorRef 结构，你那边同步一下。",
    "replyTo": null,
    "ts": "2026-04-25T10:32:18.419Z",
    "readAt": null,
    "attachments": []
  }
}
```

#### 示例 4：User → Agent 推送（from.kind = 'user'）

WS 事件（仅 address）：

```json
{
  "type": "comm.message_sent",
  "ts": "2026-04-25T10:35:02.118Z",
  "messageId": "msg_1424",
  "from": "user:local",
  "to": "local:inst_leader_01"
}
```

反查后的 envelope（节选）：

```json
{
  "envelope": {
    "id": "msg_1424",
    "from": { "kind": "user", "address": "user:local", "displayName": "User" },
    "to":   { "kind": "agent", "address": "local:inst_leader_01", "displayName": "总控", "instanceId": "inst_leader_01", "memberName": "leader" },
    "kind": "task",
    "summary": "开始沙箱化",
    "content": "请派后端和前端开始沙箱化工作。",
    "teamId": "team_01HX8A0QWERTYU",
    "replyTo": null,
    "ts": "2026-04-25T10:35:02.105Z",
    "readAt": null
  }
}
```

#### 示例 5：System → Agent 推送（from.kind = 'system'）

反查后：

```json
{
  "envelope": {
    "id": "msg_1425",
    "from": { "kind": "system", "address": "local:system", "displayName": "系统" },
    "to":   { "kind": "agent", "address": "local:inst_qa_02", "displayName": "QA 小兰", "instanceId": "inst_qa_02", "memberName": "qa" },
    "kind": "system",
    "summary": "你已被踢出团队",
    "content": "",
    "teamId": null,
    "replyTo": null,
    "ts": "2026-04-25T10:36:44.890Z",
    "readAt": null
  }
}
```

### 6.5 前端渲染规则

前端按 `envelope.from.kind`（三值：`user | agent | system`）切换样式，**不需要自己推断**（Part A §6 承诺后端强注入）。

| from.kind | 颜色（徽标） | 头像 | 显示名取值 | 气泡对齐 |
|---|---|---|---|---|
| `user` | 蓝色 `#2F6FEB` | 用户头像 | `from.displayName`（默认 "User"） | 右 |
| `agent` | 绿色 `#27AE60` | 按 `from.memberName` 取角色图 | `from.displayName`（alias 优先） | 左 |
| `system` | 灰色 `#8C8C8C` | 系统齿轮图标 | `from.displayName`（默认 "系统"） | 居中（窄气泡） |

**leader 标识**：Envelope 未直出 `isLeader`，前端通过 `from.instanceId` 查本地 `team_members` 缓存或调现有 `/api/teams/by-instance/:id` 判断；若是 leader，在绿色基础上叠加紫色皇冠徽标。**这是前端自己的 UI 叠加，不污染 Envelope 契约**。

**to 侧渲染**（谁→谁）：
- `to.kind === 'agent'`：气泡右上角小标签 `→ to.displayName`。
- `to.kind === 'user'`：不显示额外标签（视为"本机用户"）。
- `to.kind === 'system'`：一般不存在 — agent 不会向 system 发消息（`send_msg` 的 kind 枚举不含 `system`），此情况算降级渲染，显示灰标签 `→ 系统`。

**按 `envelope.kind` 加小图标**：

| envelope.kind | 图标 | 说明 |
|---|---|---|
| `chat` | 无 | 普通对话 |
| `task` | 任务徽标 | 任务分派（clipboard SVG） |
| `broadcast` | 喇叭徽标 | 广播 |
| `system` | 齿轮徽标 | 系统通知 |

**通知行 vs 聊天气泡**：
- Part A §3.4 规定 agent **driver.prompt 注入的通知行**只有一行：`@<displayName>>${summary}  [msg_id=<id>]`。这是 agent 内部的上下文注入，**不走前端渲染**。
- 前端聊天气泡渲染的是**完整 envelope**（摘要 + 全文）。两套视图不冲突。

---

## 第七部分：前端 HTTP API

**完全采用 Part A §6 的路径**，不另造。前端之前假定的 `/api/teams/:teamId/messages` 不复存在，改用 A 定义的入口。

### 7.1 用户发消息（唯一入口）

```
POST /api/messages/send
```

**请求 body**（严格匹配 Part A §6）：`Pick<MessageEnvelope, 'to' | 'summary' | 'content' | 'kind' | 'replyTo' | 'attachments'>`，**不包含 `from`**。

```json
{
  "to": {
    "kind": "agent",
    "address": "local:inst_leader_01",
    "displayName": "总控",
    "instanceId": "inst_leader_01",
    "memberName": "leader"
  },
  "summary": "开始沙箱化",
  "content": "请派后端和前端开始沙箱化工作。",
  "kind": "task",
  "replyTo": null,
  "attachments": []
}
```

**简化形式**（前端实际发送的最小 body）：仅 `to.address` 就足够路由；后端会把 `to` 补完（反查 `role_instances` 得 `displayName / instanceId / memberName`）。前端应采用简化形式：

```json
{
  "to": { "kind": "agent", "address": "local:inst_leader_01" },
  "summary": "开始沙箱化",
  "content": "请派后端和前端开始沙箱化工作。",
  "kind": "task"
}
```

**响应**：

```json
{ "messageId": "msg_1424" }
```

**后续链路**：前端发起 POST 后，后端 router 落库 → bus emit `comm.message_sent` → WS 推给所有订阅者（含发送端自己）。前端**靠 WS 自回显**把消息插入聊天列表；POST 的 `messageId` 用于**去重**（若 WS 比 HTTP response 先到，按 id 合并）。

**from 强注入**：会话 session 里是什么身份就注入什么。前端 session = HTTP 入口 = `from.kind = 'user'`，强注入不可覆写。

### 7.2 查单条消息全文

```
GET /api/messages/:id
```

**用途**：
1. 前端收到 WS `comm.message_sent` 推送后按 `messageId` 反查（§6.3 主流程）。
2. 用户点击 inbox 摘要展开全文时。

**响应**：

```json
{ "envelope": /* 完整 MessageEnvelope，见 6.4 示例 3 */ }
```

**错误**：
- `404` — 消息不存在 / 已因 CASCADE 删除。
- 目前**不做**基于 session 的收件人鉴权（Phase 2 再加），任何订阅者都能查。

### 7.3 查角色收件箱（摘要列表）

```
GET /api/role-instances/:instanceId/inbox?peek=true
```

**用途**：渲染侧栏「未读清单」。注意**只返摘要，不含 content**（A §3.3 定义）。

**查询参数**：

| 参数 | 必填 | 说明 |
|---|---|---|
| `peek` | 否 | `true`（默认）仅查看，不标已读；`false` 查看后把所有返回的消息标为已读。 |

**响应**（字段严格对齐 A §3.3 `InboxSummary`）：

```json
{
  "messages": [
    {
      "id": "msg_1423",
      "from": {
        "kind": "agent",
        "address": "local:inst_backend_01",
        "displayName": "后端A",
        "instanceId": "inst_backend_01",
        "memberName": "backend"
      },
      "summary": "接口字段确认",
      "kind": "chat",
      "replyTo": null,
      "ts": "2026-04-25T10:32:18.419Z",
      "readAt": null
    }
  ],
  "total": 1
}
```

**前端用法**：
- 首屏渲染团队成员侧栏时，为每个角色实例调一次 `inbox?peek=true`，展示未读角标。
- 用户点开某条消息 → 调 7.2 拿全文 → 调 7.4 标已读。

### 7.4 标已读

Part A 未单独定义 HTTP 端点；可通过两种方式标已读：

**方式 1（推荐）**：前端调 7.3 时传 `peek=false` — 一次性把所有返回消息批量标已读。适合"用户点开整个 inbox 面板"的语义。

**方式 2（细粒度）**：前端调 7.2 `GET /api/messages/:id` 时加 `?markRead=true` — 单条标已读。**此参数需要 A 侧在 router 层补上**（对应 `read_message` 工具的 `markRead` 参数）。

**待 A 确认**：§7.4 的 "单条标已读" 选用方式 2 还是独立新建 `POST /api/messages/:id/read`。我倾向方式 2，HTTP 表面少一个端点。

### 7.5 按团队查历史（补充接口请求）

Part A 未覆盖"**翻页查某个团队的历史聊天**"场景。前端多方聊天 UI 至少需要一个按 teamId 查消息历史的接口：

```
GET /api/teams/:teamId/messages?before=<messageId>&limit=50
```

**响应**：

```json
{
  "items": [ /* InboxSummary[]，字段同 7.3 */ ],
  "nextBefore": "msg_1020",
  "hasMore": true
}
```

**分页**：游标式，`before` 是上一页最老一条的 id；`hasMore=false` 表示到底。

**为什么要这个接口**：7.3 是"按收件人 inbox"，无法按"团队频道"翻历史。前端团队频道视图必须按 `team_id` 查。

> 此接口为**对 A 的新增请求**，需要 A 确认是否加在 `packages/backend/src/api/...`。若 A 认为 inbox 可以派生出来（`to_instance_id IN team_members`），我这边按 7.3 + 前端合并也行，但性能会差。

### 7.6 路径一览

| 场景 | 方法 | 路径 | Part A 定义 | 状态 |
|---|---|---|---|---|
| 用户发消息 | POST | `/api/messages/send` | ✅ | 确定 |
| 查单条全文 | GET | `/api/messages/:id` | ✅ | 确定 |
| 查实例收件箱 | GET | `/api/role-instances/:id/inbox?peek=true` | ✅ | 确定 |
| 按团队翻历史 | GET | `/api/teams/:teamId/messages?before=&limit=` | ❌ | **请 A 确认是否新增** |
| 单条标已读 | GET | `/api/messages/:id?markRead=true` | ❌ | **请 A 确认参数或单独建端点** |

---

## 第八部分：前端数据模型（共享自 Part A）

前端**直接从** `packages/shared/types/envelope.ts` 导入（A 承诺 re-export 后端 `packages/backend/src/comm/envelope.ts` 的三个类型）：

```ts
import type { MessageEnvelope, ActorRef, MessageKind } from 'shared/types/envelope';
```

三个核心类型以 Part A §2.1 为准。前端**不再重复定义**，以下仅列前端 store 专属的派生类型：

```ts
// 前端 store 顶层
export interface ChatStore {
  selfUserAddress: string;                    // 例如 'user:local'
  byMessageId: Map<string, MessageEnvelope>;  // 全局缓存，去重
  byTeam: Map<string, TeamChatState>;
  byInstance: Map<string, InstanceChatState>;
}

// 团队频道视图
export interface TeamChatState {
  teamId: string;
  messageIds: string[];                // 按 ts 正序的 id 列表，指向 byMessageId
  loadedEarliestId: string | null;
  hasMoreEarlier: boolean;
}

// 实例收件箱视图
export interface InstanceChatState {
  instanceId: string;
  unreadIds: string[];                 // 未读消息 id
  unreadByPeerAddress: Map<string, number>;  // 按对方 address 聚合未读数
}
```

**去重约定**：
- 所有消息以 `envelope.id` 为唯一键。
- POST 7.1 成功返回 `messageId` → 插 `byMessageId`（placeholder）；WS `comm.message_sent` 到达 → 调 7.2 拉完整 envelope → 合并到 `byMessageId`。
- WS 断线重连后**必须调 7.5**（按团队重拉最新一页），补齐断线期间的 gap。

**按 `from.kind` 渲染**（表格见 §6.5），前端不再推断 leader/user 等边缘属性。

---

## 第九部分：前端 ↔ 后端接口对照表（最终）

| 场景 | 入口 | 方法 | 路径 | 请求要点 | 响应要点 | 相关 bus 事件 |
|---|---|---|---|---|---|---|
| 订阅全局事件 | WS | — | `/ws/events` | — | 白名单事件流 | 白名单所有 |
| 用户发消息 | HTTP | POST | `/api/messages/send` | `to`, `summary?`, `content`, `kind?`, `replyTo?` | `{ messageId }` | `comm.message_sent`（自回显） |
| 查单条全文 | HTTP | GET | `/api/messages/:id` | — | `{ envelope }` | — |
| 查实例收件箱 | HTTP | GET | `/api/role-instances/:id/inbox?peek=` | — | `{ messages: InboxSummary[], total }` | — |
| 按团队翻历史 | HTTP | GET | `/api/teams/:teamId/messages` | `before?`, `limit?` | `{ items, nextBefore, hasMore }` | **待 A 确认** |
| 单条标已读 | HTTP | GET | `/api/messages/:id?markRead=true` | — | `{ envelope }` | `comm.message_received`（若 A 选择复用该事件） |
| 消息落库 | WS 推 | — | — | — | `{ messageId, from, to }` | `comm.message_sent` |
| 消息送达 agent | WS 推 | — | — | — | `{ messageId, from, to, route }` | `comm.message_received` |

---

## 第十部分：对 Part A 的回复与对齐结论

对 A 在 Part A 文档末尾提出的 4 个对抗问题的答复：

**Q1：ActorRef 结构够不够前端渲染？差字段直接说。**
A：**够**。三元 `kind` + `address` + `displayName` 覆盖所有渲染分支；`instanceId / memberName` 够做头像/角色图索引。**不差字段**。唯一一个 UI 叠加需求——leader 皇冠——我可以前端自行查 `/api/teams/by-instance/:id`，不污染 Envelope。

**Q2：`from.kind` 用 union 是否比加 isAgent/isUser 布尔更合理？**
A：**union 更合理**。TypeScript discriminated union 前端天然可穷举（`switch(kind)` 不漏 case），布尔多个会出现非法组合（`isAgent && isUser`）。维持 A 的 `'user' | 'agent' | 'system'`。

**Q3：bus 事件要不要加 envelopeId？**
A：**不加**。理由：
- bus/types.ts:99-112 现有字段稳定，避免订阅者 schema breaking。
- `messageId` 就是 `envelope.id`（Part A §4.1 `envelope_uuid` 设计下两者等价），前端用 `messageId` 反查 `GET /api/messages/:id` 得到完整 envelope，一次 HTTP 对聊天场景完全够用（§6.3）。
- 未来要提速，**在 WS subscriber 层做 enrich**（监听 `comm.message_sent` → 反查 → 以独立 WS channel 推完整 envelope）即可，不动 bus 契约。

**Q4：inbox 的 InboxSummary shape 够用吗？**
A：**够**。`{ id, from, summary, kind, replyTo, ts, readAt }` 足以渲染侧栏未读清单（头像/来源通过 `from` 得到，时间通过 `ts`，排序通过 `id` 或 `ts`）。

---

## 对 A 的反向请求（需要 A 确认/增补）

1. **新增接口** `GET /api/teams/:teamId/messages?before=&limit=`（§7.5）—— 前端按团队频道翻历史的必要端点。我倾向 A 在 `packages/backend/src/api/` 下加一个薄层复用 MessageStore。
2. **标已读语义** —— §7.4 的两种方式选一个。我倾向 `GET /api/messages/:id?markRead=true`（与 `read_message` 工具的 `markRead` 参数对齐）。
3. **前端 POST 的 `to` 字段最小化** —— 前端只传 `{ kind, address }` 两个字段，后端自动补全 `displayName/instanceId/memberName`。A 在 EnvelopeBuilder 里做这步补全，OK 吗？
4. **`to.kind === 'system'` 是否允许** —— agent 视角 A 已禁（send_msg 的 kind 枚举不含 system）；那用户前端发消息时，`to.kind` 白名单应该是 `'agent'` 一种？还是允许 `'user'`（给自己发 note）？

收到 A 回复后定稿。

---

## 变更日志

| 日期 | 改动 | 作者 |
|---|---|---|
| 2026-04-25 | 初版（未吃 A 契约） | 架构师 B |
| 2026-04-25 | 对齐 Part A：采用 A 的 Envelope 字段名（`kind` / `ts` / `readAt` / `replyTo`）、ActorRef 三元、HTTP 路径、bus 事件（不加 envelopeId）；新增对 A 的反向请求 4 条 | 架构师 B |
