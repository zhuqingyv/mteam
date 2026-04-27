# `http/routes/messages.routes.ts`（W2-I）

对齐 `docs/phase-sandbox-acp/comm-model-frontend.md` §7；前端消息四端点。

## 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/messages/send` | 用户发消息（强注入 `from.kind='user'`） |
| GET  | `/api/messages/:id` | 查单条；`?markRead=true` 同步标已读 |
| GET  | `/api/role-instances/:instanceId/inbox` | 摘要列表；`?peek=false` 取走后标已读 |
| GET  | `/api/teams/:teamId/messages` | 团队历史；`?before=<msgId>&limit=` 游标分页 |

## 依赖

- `comm/envelope-builder.buildEnvelope`（W1-B）
- `comm/message-store.createMessageStore`（W1-C）
- `comm/router.CommRouter.dispatch`（W2-C）通过 `setMessagesContext({ router })` 注入
- `role_instances` 表（`id / alias / member_name`）作 `to` 字段 lookup 补全

`http/server.ts:startServer` 在 `new CommServer(...)` 之后调 `setMessagesContext({ router: comm.router })`；`createServer` 单测不启 comm → POST /send 降级 503。

## 请求/响应

### POST /api/messages/send

```bash
curl -X POST http://localhost:58590/api/messages/send \
  -H 'content-type: application/json' \
  -d '{"to":{"kind":"agent","address":"local:inst_leader"},"content":"hi","summary":"开工","kind":"task"}'
```

Body（严格）：

```ts
{
  to: { kind: 'agent', address: string, instanceId?, displayName?, memberName? },
  content: string,         // 必填
  summary?: string,        // 默认 "给你发了一条消息"
  kind?: 'chat'|'task'|'broadcast',  // 默认 'chat'；'system' 禁
  replyTo?: string | null,
  attachments?: Array<{ type: string, ... }>,
  // from 字段若传会被忽略（stderr warn），强注入为 user。
}
```

- `to.kind` 白名单：仅 `'agent'`（`user` / `system` → 400）
- `to` lookup 补全：前端只传 `{kind, address}` 即可，后端反查 `role_instances` 得 `alias / memberName / instanceId`；`alias` 优先填 `displayName`
- 若 body 主动带 `instanceId`，会与 `parseAddress(address).id` 做一致性校验（不一致 → 400）

响应：

```json
{ "messageId": "msg_...", "route": "local-online" | "local-offline" | "system" }
```

错误：

| 状态 | 场景 |
|---|---|
| 400 | body 不是 JSON / 缺 `to.address` / 缺 `content` / `to.kind` 非 `agent` / `kind='system'` / dropped |
| 404 | `to.address` 解析出的实例不存在 |
| 415 | Content-Type 不是 `application/json` |
| 503 | comm router 未注入（createServer 单进程起 http、comm 未启动） |

### GET /api/messages/:id

- 命中 → `200 { envelope: MessageEnvelope }`
- 不存在 → 404
- `?markRead=true` → 同步调 `store.markRead(id)`，响应返回已更新的 envelope（`readAt` 非 null）
- 默认不带 markRead → 不动 `read_at`

### GET /api/role-instances/:instanceId/inbox

- `?peek=true`（默认） → 只查摘要，不标已读
- `?peek=false` → 返回后把取走的消息批量标已读
- `?limit=N`（1..200，默认 50）
- 实例不存在 → 404

返回结构来自 `MessageStore.listInbox`：

```ts
{ messages: InboxSummary[], total: number }
```

`InboxSummary` **不含 content 字段**（契约：摘要只给前端侧栏未读面板渲染；全文走 `GET /api/messages/:id`）。

### GET /api/teams/:teamId/messages

- `?before=<messageId>&limit=N` 游标翻页（按 `id DESC`）
- 未传 `before` → 取最新一页

返回：

```ts
{ items: InboxSummary[], nextBefore: string | null, hasMore: boolean }
```

## 注入契约（messages-context.ts）

```ts
setMessagesContext({ router: CommRouter | null, store?: MessageStore })
resetMessagesContext()  // 测试 afterAll / beforeEach 用
```

`router` 不在时：POST /send → 503；GET 端点正常工作（store 走 `createMessageStore()` lazy 建）。

## 单测覆盖（`src/__tests__/http-messages.test.ts`）

| 端点 | 场景 |
|---|---|
| POST /send | 最小 body 200 + lookup 补全 + user 强注入 / 伪造 from 被覆盖 / address 不存在 404 / Content-Type 非 JSON 415 / `to.kind=user` 400 / 缺 content 400 / router 未注入 503 / instanceId 冲突 400 |
| GET /:id | 命中 200 / 不存在 404 / markRead=true 写 read_at / 默认不写 |
| GET inbox | peek=true 不标已读 / peek=false 标已读 / 摘要不含 content / 实例不存在 404 |
| GET team/messages | 5 条 limit=2 三页翻到底 / 空 team 返空 |

对应 TASK-LIST W2-I U-130 ~ U-143。
