# comm/envelope.ts

> mteam 通信模型的核心信封类型 + 运行时类型守卫。所有通信层（router / tool / subscriber / HTTP / DAO / 前端 WS payload）都只 `import type` 这一份定义。

## 这个模块是什么

一句话：**定义 `MessageEnvelope` / `ActorRef` 两个数据结构，以及对应的 `isActorRef` / `isMessageEnvelope` 运行时守卫**。纯类型文件，零运行时依赖（不 import 项目内任何模块、不 import DB / bus）。

对齐 `docs/phase-sandbox-acp/comm-model-design.md` §2.1 ~ §2.3。

## 接口定义

```typescript
export type ActorKind = 'user' | 'agent' | 'system';
export type MessageKind = 'chat' | 'task' | 'broadcast' | 'system';

export interface ActorRef {
  kind: ActorKind;
  address: string;
  displayName: string;
  instanceId?: string | null;
  memberName?: string | null;
  origin?: 'local' | 'remote';
}

export interface MessageEnvelope {
  id: string;
  from: ActorRef;
  to: ActorRef;
  teamId: string | null;
  kind: MessageKind;
  summary: string;
  content?: string;
  replyTo: string | null;
  ts: string;
  readAt: string | null;
  attachments?: Array<{ type: string; [k: string]: unknown }>;
}

export function isActorRef(x: unknown): x is ActorRef;
export function isMessageEnvelope(x: unknown): x is MessageEnvelope;
```

## 使用示例

```typescript
import { isMessageEnvelope, type MessageEnvelope } from './envelope.js';

// 1. 作为类型：router / builder / store 全部 `import type`
function dispatch(env: MessageEnvelope): void { /* ... */ }

// 2. 作为运行时守卫：从 WS / HTTP 收到 unknown → 校验后消费
const payload: unknown = JSON.parse(frame);
if (isMessageEnvelope(payload)) {
  dispatch(payload);
}
```

## MessageEnvelope 字段语义

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 全局唯一；DB 写入成功后形如 `msg_${dbId}`，前端可直接作为 React key。不允许前端/agent 自行生成。 |
| `from` | `ActorRef` | 是 | 发送方。`kind` 在 EnvelopeBuilder 按入口强注入（HTTP=`user`，MCP tool=`agent`，bus 内部=`system`）—— 防伪造核心。 |
| `to` | `ActorRef` | 是 | 接收方。由 `send_msg.to` 经 lookup 解析到 `address`，再从 `role_instances` 反查 `instanceId / memberName / displayName`。 |
| `teamId` | `string \| null` | 是 | 对应 `teams.id`；跨团队或系统消息为 null。 |
| `kind` | `MessageKind` | 是 | 默认 `chat`；值域对齐 `messages.kind` CHECK 约束。 |
| `summary` | `string` | 是 | ≤ 200 字；通知行只展示这一字段（`@<displayName>>${summary}`）。 |
| `content` | `string` | 否 | 消息全文；`read_message` 返回。允许为空（纯通知）。 |
| `replyTo` | `string \| null` | 是 | 指向另一条 envelope 的 id；前端画 thread。 |
| `ts` | `string` | 是 | ISO 8601 UTC；EnvelopeBuilder 注入，调用方不能改。 |
| `readAt` | `string \| null` | 是 | 未读为 null；`check_inbox` / `read_message` 写入。 |
| `attachments` | `Array<{type, ...}>` | 否 | 本期不校验，仅透传；前端渲染白名单 `[file, link, table]`。 |

## ActorRef 字段语义

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `kind` | `ActorKind` | 是 | 回答「谁发的」；EnvelopeBuilder 强注入，调用方传入值被忽略。 |
| `address` | `string` | 是 | 稳定地址；对齐 `comm/protocol.ts` 的 `Address`。`user:<uid>` / `user:local` / `local:<instanceId>` / `remote:<hub>:<instanceId>` / `local:system`。 |
| `displayName` | `string` | 是 | UI / 通知行唯一可读文案。user 默认 `User`，system 默认 `系统`，agent 取 `role_instances.member_name`（带 alias 时优先 alias）。 |
| `instanceId` | `string \| null` | 否 | agent 专用；对应 `role_instances.id`。user / system 为 null 或不填。 |
| `memberName` | `string \| null` | 否 | agent 专用；即角色模板中的 `member_name`。 |
| `origin` | `'local' \| 'remote'` | 否 | Phase 2 预留；本期恒为 `'local'`。 |

## 注意事项 / 边界行为

- **纯类型 + 纯函数守卫**：本文件不 import 任何项目内模块（`grep "from '\\.\\." envelope.ts` 应只匹配自身相对路径）。新增字段时不要引业务依赖。
- **守卫语义**：`isActorRef` / `isMessageEnvelope` 只做结构校验（字段存在 + 类型 + 枚举值），**不做业务校验**（如 `address` 格式是否合法、`kind='system'` 是否允许等）。业务校验留给 `envelope-builder.ts` / router。
- **`id` 不允许空串**：守卫显式拒绝 `id === ''`，防止落库失败的 envelope 被当作合法对象。
- **枚举值域固定**：`ActorKind` / `MessageKind` 新增值必须同步改 `db/schemas/messages.sql` 的 `CHECK` 约束，不然落库会炸。
- **向前不兼容变更**：扩字段用可选（`?:`）；已有字段改类型 = 破坏性，需要跨 Phase 迁移。

## 测试

`__tests__/envelope.test.ts` 覆盖 REGRESSION.md §1.1 的 U-01 ~ U-06：

- U-01：3 条合法 ActorRef（agent / user / system）→ `true`
- U-02：缺字段 / kind 非法 / 非 object → `false`
- U-03：完整 envelope / 仅必填 / 带 attachments → `true`
- U-04：缺 id / kind 非法 / `to` 非 ActorRef → `false`
- U-05：`tsc --noEmit` 零错（随 backend typecheck）
- U-06：不 import 项目内业务模块（随 grep 巡检）

运行：

```bash
cd packages/backend
bun test src/comm/__tests__/envelope.test.ts
```
