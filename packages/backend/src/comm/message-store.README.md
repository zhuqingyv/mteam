# `comm/message-store.ts`

## 是什么

`messages` 表的 DAO（W1-C 交付物）。所有 envelope 的读写统一入口，取代老 `comm/offline.ts` 里
"store / replayFor / markDelivered" 三个散函数。router、subscriber、HTTP 路由、MCP 工具全部走这里。

## 接口

```typescript
import type { MessageEnvelope, MessageKind } from './envelope.js';

export interface InboxSummary {
  id: string;
  from: { kind: string; address: string; displayName: string;
          instanceId: string | null; memberName: string | null };
  summary: string;
  kind: MessageKind;
  replyTo: string | null;
  ts: string;
  readAt: string | null;
}

export interface MessageStore {
  /** 写一条 envelope。同 envelope_uuid 再写返回已有 dbId（幂等）。 */
  insert(env: MessageEnvelope): number;

  /** 按 envelope.id（对外暴露的 uuid）取全文。未命中返 null。 */
  findById(envelopeId: string): MessageEnvelope | null;

  /** 幂等标记已读；返回受影响行数（未读→1，已读→0）。 */
  markRead(envelopeId: string, at?: Date): number;

  /** 按收件人查未读摘要；peek=false 时同步批量标记已读。 */
  listInbox(
    toInstanceId: string,
    opts: { peek: boolean; limit?: number },
  ): { messages: InboxSummary[]; total: number };

  /** 按团队翻历史，envelope_uuid 游标分页。 */
  listTeamHistory(
    teamId: string,
    opts: { before?: string; limit?: number },
  ): { items: InboxSummary[]; nextBefore: string | null; hasMore: boolean };

  /** 某实例所有未读原始 envelope（replay.ts 用）。 */
  findUnreadFor(toInstanceId: string): MessageEnvelope[];
}

export function createMessageStore(): MessageStore;
```

## 使用

```typescript
import { createMessageStore } from './message-store.js';
const store = createMessageStore();       // 共享 getDb() 单例
const dbId = store.insert(envelope);       // 先落库
bus.emit(commMessageSent(envelope.id));    // 再广播；msg_id 此时已可查
const full = store.findById(envelope.id); // read_message HTTP 反查
```

## 注意事项

- **不依赖单例耦合**：只用 `getDb()`；不 import bus / router / mcp 任何模块。
- **幂等 insert**：上游重试同 `envelope.id` 不会多写一行，返回既有 `dbId`。
- **listInbox 只返摘要**：返回值**不含 `content`**。前端/agent 要全文用 `findById`。
- **peek 语义**：`peek=true` 只读取；`peek=false` 在同一事务内批量 markRead（返回的 `summary.readAt` 仍反映取走前的未读态）。
- **listTeamHistory 游标**：`before` 是 `envelope_uuid`，不是 dbId，保证前端稳定。
- **测试约束**：用 `TEAM_HUB_V2_DB=:memory:` 跑 `bun test`；FK 开启，fixtures 需要预置 `role_instances` / `teams` 行（见 `__tests__/message-store.test.ts` 的 `bootstrapFixtures`）。

## 与老 `comm/offline.ts` 的字段映射

| 老 `offline.ts`（基于 `Message`） | 新 `message-store.ts`（基于 `MessageEnvelope`） |
|---|---|
| `store(msg)`：只在离线分支调；INSERT `from_instance_id/to_instance_id/kind='chat'/summary/content/sent_at` | `insert(env)`：在 router 入口调；多写 `from_kind/to_kind/from_display/to_display/envelope_uuid/from_user_id/attachments_json` |
| `msg.from`/`msg.to`（地址字符串）→ `parseAddress` 抽 `id`，scope 非 local 或 id='system' 返回 null | `env.from.instanceId` / `env.to.instanceId`（已由 envelope-builder 解析）；`env.from.kind` / `env.to.kind` 标 user/agent/system |
| `msg.payload.summary`（可缺）→ `summary`；`JSON.stringify(payload)` → `content` | `env.summary`（envelope-builder 保证非空）/`env.content` 直接写列；attachments 单独序列化到 `attachments_json` |
| 没有 envelope uuid；对外用内部 dbId | 用 `env.id`（`msg_<uuid>`）作为对外 id，DB 侧写 `envelope_uuid` 列 |
| `replayFor(address)` 返回 `Message[]`（payload 是 `JSON.parse(content)`） | `findUnreadFor(toInstanceId)` 返回 `MessageEnvelope[]`，字段按 §4.2 还原 |
| `markDelivered(dbId number)`：按内部 id 标记 | `markRead(envelopeId string)`：按对外 uuid 标记；幂等返回行数 |
| 没有分页 | `listInbox` 提供 limit/total；`listTeamHistory` 提供 `before` 游标 |

## 字段还原规则（§4.2）

| DB 列 | envelope / summary 字段 |
|---|---|
| `envelope_uuid` | `id` |
| `from_kind` + `from_instance_id` + `from_user_id` | `from.kind`、`from.address`（kind 拼回），`from.instanceId` |
| `from_display` | `from.displayName` |
| `to_kind` + `to_instance_id` | `to.kind`、`to.address`、`to.instanceId` |
| `to_display` | `to.displayName` |
| `team_id` / `kind` / `summary` / `content` / `sent_at` / `read_at` | `teamId` / `kind` / `summary` / `content` / `ts` / `readAt` |
| `reply_to_id` | 反查出对应 `envelope_uuid` 放进 `replyTo` |
| `attachments_json` | `JSON.parse`，非数组或坏 JSON 时省略 `attachments` |

## 边界行为

- `to_instance_id` 列 `NOT NULL`：router 在 dropped / remote 分支**不调** insert，由上游保证 agent-to-agent 的 envelope 才进来。
- `envelope_uuid` UNIQUE 约束：由 W2-J migration 在 backfill 完成后建立。当前 W1-C **不建 UNIQUE**，insert 的幂等靠 SELECT + 早返。
- `attachments_json` 坏 JSON：envelope 返回时省略 `attachments`，不抛异常（让 backfill/升级过程更稳）。
