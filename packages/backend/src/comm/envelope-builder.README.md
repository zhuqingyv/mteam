# comm / envelope-builder（W1-B）

Phase 通信管道 · Wave 1 非业务模块。

## 一句话

**纯函数** `buildEnvelope(input, options?)` → `MessageEnvelope`。调用方查好 DB / domain，把事实喂进来；builder 只做组装 + 校验。

## 为什么独立成纯函数

- 业务层（HTTP route / MCP tool / bus subscriber）各自有自己的 `from` 身份上下文，查 DB 的职责留给业务层；
- builder 不 import DB / bus / domain，零单例耦合 → 单测不需要 mock；
- `fromKind` 由调用入口强注入，任何从 body / args 里解析出来的 `from.kind` 都会被直接覆盖 → **防伪造**（见 `comm-model-design.md` §6）。

## 接口

```typescript
import type {
  ActorKind,
  ActorRef,
  MessageEnvelope,
  MessageKind,
} from './envelope.js';

export interface AgentLookup {
  instanceId: string;
  memberName: string;
  displayName: string; // alias 优先，其次 memberName
}

export interface BuildEnvelopeInput {
  // 身份强注入
  fromKind: ActorKind;
  fromAddress: string;
  fromLookup?: AgentLookup | null;         // agent 必填
  fromDisplayNameOverride?: string;        // user/system 覆盖默认 displayName

  // 接收方
  toAddress: string;
  toLookup?: AgentLookup | null;           // agent 地址必填

  // 业务字段
  summary: string | null | undefined;      // 空时填 "给你发了一条消息"
  content: string | undefined;
  kind?: MessageKind;                      // 默认 'chat'
  replyTo?: string | null;
  teamId?: string | null;
  attachments?: MessageEnvelope['attachments'];

  // 测试注入
  now?: () => Date;
  generateId?: () => string;               // 默认 msg_${randomUUID()}
}

export interface BuildEnvelopeOptions {
  allowSystemKind?: boolean;               // 仅 bus subscriber 入口开启
}

export function buildEnvelope(
  input: BuildEnvelopeInput,
  options?: BuildEnvelopeOptions,
): MessageEnvelope;
```

## 使用示例

### 1. MCP 工具（send_msg）内部：agent → agent

```ts
const envelope = buildEnvelope({
  fromKind: 'agent',
  fromAddress: commSelfAddress,                       // 'local:inst_alice'
  fromLookup: await lookupAgent(commSelfAddress),     // 业务侧查 DB
  toAddress: resolved.toAddress,
  toLookup: await lookupAgent(resolved.toAddress),
  summary: args.summary,
  content: args.content,
  kind: args.kind,            // 'chat' | 'task' | 'broadcast'；'system' 会被拒
  replyTo: args.replyTo,
  teamId: ctx.teamId,
});
```

### 2. HTTP `/api/messages/send`：user → agent

```ts
const envelope = buildEnvelope({
  fromKind: 'user',                                   // 强注入（忽略 body.from）
  fromAddress: 'user:local',
  fromLookup: null,
  fromDisplayNameOverride: body.fromDisplayName,      // 可选
  toAddress: body.to.address,
  toLookup: await lookupAgent(body.to.address),
  summary: body.summary,
  content: body.content,
});
```

### 3. bus subscriber：system → agent（如成员下线通知）

```ts
const envelope = buildEnvelope(
  {
    fromKind: 'system',
    fromAddress: 'local:system',                      // 会被强制改写
    fromLookup: null,
    toAddress: `local:${offlineEvt.instanceId}`,
    toLookup: await lookupAgent(...),
    summary: `成员 ${memberName} 已被批准下线`,
    content: '',
    kind: 'system',
  },
  { allowSystemKind: true },                          // 仅此入口开启
);
```

## 调用方该传什么 / 不该传什么

| 场景 | 必传 | 禁止 / 无意义 |
|------|------|---------------|
| agent→* | `fromKind='agent'` + `fromLookup` + `toLookup`（若 to 是 agent 地址） | 传 `fromDisplayNameOverride`（会被忽略，displayName 来自 lookup） |
| user→agent | `fromKind='user'` + `fromAddress` + `toLookup` | 传 `fromLookup`（会被忽略） |
| system→agent | `fromKind='system'` + `toLookup` + `allowSystemKind:true` | **不**用其他入口传 `kind='system'`；`fromAddress` 会被强制改成 `local:system` |
| 所有场景 | `summary` / `content` 的原始值 | body / args 里的 `from` 字段（由入口强注入，builder 不读） |

## 注意事项 / 边界行为

- `summary` 为空串 / 仅空白 / null / undefined → 填入 `"给你发了一条消息"`（设计 §2.2）。
- `kind='system'` 在 `allowSystemKind !== true` 时抛错 —— 防止 MCP 工具 / HTTP 入口伪造系统消息。
- `fromKind='system'` 时 `fromAddress` 强制改写为 `local:system`，调用方传什么地址都会被覆盖。
- `toAddress` 解析规则：
  - 带 `toLookup` → `to.kind='agent'`（显式优先）；
  - `local:system` → `to.kind='system'`；
  - `user:` 前缀 → `to.kind='user'`；
  - 其他（如 `local:<inst>`）且无 `toLookup` → **抛错**，调用方契约违反；
- `teamId` 缺省 → `envelope.teamId=null`；builder 不查 DB 推断。
- `attachments` 原样透传；schema 校验留给 HTTP 层。
- `now / generateId` 注入后可产生可重放的 envelope（单测专用，生产环境不传）。

## 不允许的依赖

- 不 import `../db/*` / `../bus/*` / `../domain/*`；
- 允许 import：`./envelope.js`（仅 type）+ `node:crypto`；
- 任何违反都会被 U-20 测试挡下来。

## 相关

- 类型定义：`envelope.ts`（W1-A）
- 落库：`message-store.ts`（W1-C，router 内同步调 `insert`）
- 调用点：`mcp/tools/send_msg.ts`（W2-D）/ `comm/server.ts` & `mcp-http/in-process-comm.ts` & `bus/subscribers/comm-notify.subscriber.ts`（W2-K）/ `http/routes/messages.routes.ts`（W2-I）
