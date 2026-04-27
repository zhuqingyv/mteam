# Messages API

> **面向**：前端 UI（HTTP 调用方）。Agent 不走本文这些 HTTP，agent 发消息走 MCP 工具 `send_msg`（见 message-flow.md §场景3）、读消息走 MCP 工具 `read_message`（反查 DB）。

消息信封（MessageEnvelope）的 HTTP 接口。Base URL = backend HTTP host。

## 类型定义

```ts
export type ActorKind = 'user' | 'agent' | 'system';
export type MessageKind = 'chat' | 'task' | 'broadcast' | 'system';

export interface ActorRef {
  kind: ActorKind;
  address: string;              // 'user:<uid>' | 'local:<instanceId>' | 'local:system'
  displayName: string;
  instanceId?: string | null;
  memberName?: string | null;
  origin?: 'local' | 'remote';
}

export interface MessageEnvelope {
  id: string;                   // UUID
  from: ActorRef;
  to: ActorRef;
  teamId: string | null;
  kind: MessageKind;
  summary: string;
  content?: string;
  replyTo: string | null;       // 上一条 envelope.id
  ts: string;                   // ISO
  readAt: string | null;        // ISO or null
  attachments?: Array<{ type: string; [k: string]: unknown }>;
}

export interface InboxSummary {
  id: string;
  from: { kind: string; address: string; displayName: string; instanceId: string | null; memberName: string | null };
  summary: string;
  kind: MessageKind;
  replyTo: string | null;
  ts: string;
  readAt: string | null;
}
```

## POST /api/messages/send

> **调用方**：前端 UI / 后端测试面板。Agent→agent 发消息**不走这里**，走 MCP `send_msg` 工具。

发消息（前端只能以 `user` 身份发）。`body.from` 会被**强制忽略**，后端注入 `from.kind='user'`、`from.address='user:local'`。

Headers: `Content-Type: application/json`

Request body：
```json
{
  "to":       { "kind": "agent", "address": "local:<instanceId>" },
  "content":  "你好",
  "kind":     "chat",
  "summary":  "optional",
  "replyTo":  "<previous-envelope-id>",
  "attachments": [{ "type": "file", "path": "..." }]
}
```

字段规则：
- `to.address` 必填；`to.kind` 默认 `'agent'`（仅允许 `agent`）。
- 若同时给了 `to.instanceId`，必须等于 `parseAddress(to.address).id`，否则 400。
- `content` 必填且非空。
- `kind` ∈ `chat | task | broadcast`，默认 `chat`。
- 后端用 `to.address` 反查 `role_instances` 自动补全 `displayName`/`memberName`。

Response 200：
```json
{ "messageId": "<uuid>", "route": "local" }
```

## GET /api/messages/:id

按 envelope id 查单条。

Query：
- `markRead=true` → 同时把这条标记已读，返回最新的 envelope（`readAt` 填充）。

Response 200：
```json
{ "envelope": { /* MessageEnvelope */ } }
```

## GET /api/role-instances/:id/inbox

取某个 role 实例的未读收件箱。

Query：
- `peek`（默认 `true`）：`true` 只读不标已读；`false` 返回的同时把这些批量标已读。
  - **注意**：HTTP 端默认 `peek=true`（保守，面板 GET 幂等），与 MCP 工具 `check_inbox` 默认 `peek=false`（看完即读完）不同。如需对齐 MCP `check_inbox` 语义请显式传 `peek=false`。
- `limit`（1–200，默认 50）。

Response 200：
```json
{
  "messages": [ /* InboxSummary[] */ ],
  "total":    12
}
```

注：`messages.length` 受 `limit` 限制；`total` 是当前未读总数（不受 limit 影响）。

## GET /api/teams/:teamId/messages

按 team 维度拉历史（倒序，新→旧）。

Query：
- `before`（可选）：上一页最后一条的 `envelope.id`，作为游标。
- `limit`（1–200，默认 50）。

Response 200：
```json
{
  "items":      [ /* InboxSummary[]，按 ts 倒序 */ ],
  "nextBefore": "<envelope-id> | null",
  "hasMore":    true
}
```

翻下一页：把 `nextBefore` 塞回 `before`。`nextBefore=null` + `hasMore=false` 表示到底。

## 错误码

| Status | 场景                                                    |
|--------|---------------------------------------------------------|
| 400    | JSON 解析失败 / 缺 `to.address` / `content` 空 / `kind` 非法 / `to.instanceId` 与 address 不一致 / router 判定为 `dropped` / `remote-unsupported` |
| 404    | `to.address` 对应的实例不存在 / `messageId` 不存在 / `role-instances/:id` 不存在 |
| 415    | `Content-Type` 非 `application/json`（仅 /send）         |
| 503    | comm router 未初始化（仅 /send；后端没起 comm 层时才出现）|
