# Phase 通信管道 — TASK-LIST

**版本**：v2 · **日期**：2026-04-25 · **架构师**：arch-comm-a · **对抗审查**：reviewer-comm-a

> 本文件 = 模块清单 + 负责人 + 状态。每个模块都要交付 `代码 + README + 测试`（参考 `packages/backend/docs/phase-sandbox-acp/WORKFLOW.md` §3）。
> **代码引用行号基于当前 HEAD（2026-04-25）**，改造前请先 `git log <file>` 确认行号未漂移。
>
> **v2 审查修订要点**（见文末 §变更日志）：
> 1. **取消新增 `comm.message_delivered` 事件**：与 `comm-model-frontend.md` §6.2 Part B 终稿冲突，前端明确拒绝扩 payload；保留老事件 `comm.message_sent` / `comm.message_received`。
> 2. **持久化回到 router 同步**：原 W2-G subscriber 异步写库方案会造成 `driver.prompt` 里已带 `msg_id`，agent 立即 `read_message` 时 DB 尚未入行 → 404。router 内 `store.insert` 同步先行。
> 3. **W2-J 需实装 migration runner**：当前 `db/connection.ts` 只是合并 SQL 文件 exec，老库需 ALTER TABLE 逻辑，`CREATE TABLE IF NOT EXISTS` 不补列。
> 4. **POST /api/messages/send 的 `to` 字段需 lookup 补全**：前端只传 `{kind,address}` 最小形式，后端反查 `role_instances` 填 displayName / instanceId / memberName。
> 5. **replayForDriver 必须产出新格式通知行**：否则老消息上线时 agent 拿不到 msg_id → 用户要求"主动调 read_message"失效。

---

## 约定

- 每个文件 ≤ 200 行
- 非业务模块不 import 业务代码；违反一律退回
- 不 mock db / bus —— 用 `:memory:` DB + 独立 `EventBus`
- README.md 按 WORKFLOW §3 要求写（业务模块必须有时序图 + 竞态 + 错误传播）
- 所有新代码用中文注释解释 **Why**，不解释 What

---

## Wave 1 — 非业务模块（纯净层，可完全并行）

四个模块**互不依赖**，可同时起四个 agent 并行。全部完成才能进 Wave 2。

---

### W1-A · `comm/envelope.ts`（新增类型定义）

- **类型**：非业务 / 纯类型文件
- **代码位置**：`packages/backend/src/comm/envelope.ts`（新建）
- **预估行数**：~80（含注释）
- **依赖**：无

**接口契约**（直接对齐 `comm-model-design.md` §2.1）：

```typescript
export type ActorKind = 'user' | 'agent' | 'system';
export type MessageKind = 'chat' | 'task' | 'broadcast' | 'system';

export interface ActorRef {
  kind: ActorKind;
  address: string;             // parseAddress() 可解析
  displayName: string;
  instanceId?: string | null;  // agent 专用
  memberName?: string | null;  // agent 专用
  origin?: 'local' | 'remote'; // 默认 'local'，Phase 2 预留
}

export interface MessageEnvelope {
  id: string;                  // `msg_<uuid>` 或 `msg_<dbId>`
  from: ActorRef;
  to: ActorRef;
  teamId: string | null;
  kind: MessageKind;
  summary: string;
  content?: string;
  replyTo: string | null;
  ts: string;                  // ISO 8601
  readAt: string | null;
  attachments?: Array<{ type: string; [k: string]: unknown }>;
}

export function isActorRef(x: unknown): x is ActorRef;
export function isMessageEnvelope(x: unknown): x is MessageEnvelope;
```

**完成判据**：
- `tsc --noEmit` 通过
- `isActorRef` / `isMessageEnvelope` 有 3 条正向 + 3 条反向单测
- README 写清字段语义（可直接搬 `comm-model-design.md` §2.2 表格）
- 不 import 任何项目内其他模块（纯类型 + 类型守卫）

---

### W1-B · `comm/envelope-builder.ts`（纯函数）

- **类型**：非业务 / 纯函数
- **代码位置**：`packages/backend/src/comm/envelope-builder.ts`（新建）
- **预估行数**：~150
- **依赖**：W1-A（`import type`）
- **不依赖**：DB / bus / domain — 所有外部数据通过**入参注入**

**接口契约**：

```typescript
import type { MessageEnvelope, ActorRef, ActorKind, MessageKind } from './envelope.js';

/** 构造 envelope 所需的全部事实。调用方负责查 DB / domain 后喂进来。 */
export interface BuildEnvelopeInput {
  /** 强注入：调用入口决定。HTTP=user，MCP=agent，subscriber=system。 */
  fromKind: ActorKind;

  /** 原始 from 地址（from.address）。'local:system' / 'user:xxx' / 'local:<instanceId>'。 */
  fromAddress: string;
  /** agent 场景 lookup 结果；user/system 可传 null。 */
  fromLookup?: {
    instanceId: string;
    memberName: string;
    displayName: string;   // alias > memberName
  } | null;
  /** user 场景 displayName；默认 "User"。 */
  fromDisplayNameOverride?: string;

  /** 原始 to 地址。 */
  toAddress: string;
  /** agent 场景 lookup 结果。 */
  toLookup?: {
    instanceId: string;
    memberName: string;
    displayName: string;
  } | null;

  /** 业务字段。 */
  summary: string | null | undefined;    // 为空时填 "给你发了一条消息"
  content: string | undefined;
  kind?: MessageKind;                    // 默认 'chat'
  replyTo?: string | null;
  teamId?: string | null;
  attachments?: MessageEnvelope['attachments'];

  /** 注入可控的 now / id 生成器，方便测试。 */
  now?: () => Date;
  generateId?: () => string;             // 默认 `msg_${crypto.randomUUID()}`
}

export interface BuildEnvelopeOptions {
  /** 禁止 agent 工具入口传 kind='system'；HTTP user 入口禁止 kind='system'。 */
  allowSystemKind?: boolean;
}

/** 纯函数。失败抛 Error，不吞异常。 */
export function buildEnvelope(
  input: BuildEnvelopeInput,
  options?: BuildEnvelopeOptions,
): MessageEnvelope;
```

**Why 纯函数**：
- 业务层（router / send_msg / HTTP handler）查完 DB/domain 后喂参数，builder 只做组装 + 校验
- 没有单例耦合，单测不 mock DB 也能写 20 条 case

**完成判据**：
- 非业务检查：`grep "from '.." envelope-builder.ts` 只能出现 `./envelope.js` 和 node 标准库
- 单测覆盖：
  - agent→agent 正常路径
  - user→agent（fromKind 强制 'user'）
  - system→agent（fromKind 强制 'system'）
  - `summary` 为空 → 填默认
  - `kind='system'` + `allowSystemKind=false` → throw
  - `kind='system'` + `allowSystemKind=true` → 放行
  - `fromKind='agent'` 但 `fromLookup=null` → throw
  - `teamId` 缺省 → null（不查 DB）
  - `attachments` 透传
  - `generateId` 注入可控 id
- README 列出"调用方该传什么 / 不该传什么"

---

### W1-C · `comm/message-store.ts`（DAO）

- **类型**：非业务 / DAO
- **代码位置**：`packages/backend/src/comm/message-store.ts`（新建）
- **预估行数**：~180
- **依赖**：W1-A（`import type`）+ `db/connection`（getDb）
- **替代**：`comm/offline.ts`（保留，做薄 shim）

**接口契约**：

```typescript
import type { MessageEnvelope, MessageKind } from './envelope.js';

export interface InboxSummary {
  id: string;
  from: { kind: string; address: string; displayName: string; instanceId: string | null; memberName: string | null };
  summary: string;
  kind: MessageKind;
  replyTo: string | null;
  ts: string;
  readAt: string | null;
}

export interface MessageStore {
  /** 写入一条 envelope。幂等：同 envelope_uuid 再写返回已有 id。返回 rowId。 */
  insert(env: MessageEnvelope): number;

  /** 按 envelope.id 取全文。不存在返回 null。 */
  findById(envelopeId: string): MessageEnvelope | null;

  /** 标记已读（幂等）。返回受影响行数。 */
  markRead(envelopeId: string, at?: Date): number;

  /** 按收件人查未读摘要列表；peek=false 时批量 markRead。 */
  listInbox(toInstanceId: string, opts: { peek: boolean; limit?: number }): {
    messages: InboxSummary[];
    total: number;
  };

  /** 按团队翻历史，游标分页。 */
  listTeamHistory(teamId: string, opts: { before?: string; limit?: number }): {
    items: InboxSummary[];
    nextBefore: string | null;
    hasMore: boolean;
  };

  /** 回灌：某实例所有未读原始 envelope（replay.ts 用）。 */
  findUnreadFor(toInstanceId: string): MessageEnvelope[];
}

export function createMessageStore(): MessageStore;  // 单例或每调用 new，见 README
```

**Why 独立模块**：
- 现状 `comm/offline.ts` 同时承担"写/读/标记已读"三职，且 `store()` 只在离线分支调用，在线消息从没落库
- 统一成 DAO 后，router / subscriber / HTTP / tool 都走同一入口

**完成判据**：
- 非业务检查：只 import `./envelope.js` + `../db/connection.js` + node 标准库
- 单测用 `:memory:` DB：
  - insert 新消息 → dbId 递增
  - insert 同 `envelope_uuid` 两次 → 返回同一 id（幂等）
  - findById 命中 / 未命中
  - markRead 已读状态再调返回 0
  - listInbox peek=true 不改 read_at；peek=false 批量改
  - listTeamHistory before 游标正确、hasMore 边界
  - findUnreadFor 返回完整 envelope（不是 Message）
- README 给出 **与老 `offline.ts` 的字段映射表**（见 `comm-model-design.md` §4.2）

---

### W1-D · `mcp/tools/read_message.ts`（新工具）

- **类型**：非业务 / 纯工具实现（MCP handler）
- **代码位置**：`packages/backend/src/mcp/tools/read_message.ts`（新建）
- **预估行数**：~80
- **依赖**：**仅 `import type { MessageEnvelope } from '../../comm/envelope.js'`（W1-A）** + 现有 `http-client.ts`（HTTP 反查走 `/api/messages/:id`）

> 澄清：Wave 1 的"并行不相互依赖"指**运行时**不相互依赖。`import type` 编译期擦除，不构成运行时耦合，允许在 W1 内部使用。
> 这里**不直连 W1-C message-store**（否则 tool 会拉进 DB 依赖，变业务模块）。

**接口契约**（对齐 `comm-model-design.md` §3.2）：

```typescript
export const readMessageSchema = {
  name: 'read_message',
  description: '...',
  inputSchema: {
    type: 'object' as const,
    properties: {
      messageId: { type: 'string', description: '...' },
      markRead: { type: 'boolean', default: true },
    },
    required: ['messageId'],
    additionalProperties: false,
  },
};

export async function runReadMessage(
  env: MteamEnv,
  args: { messageId?: unknown; markRead?: unknown },
): Promise<{ envelope: MessageEnvelope } | { error: string }>;
```

**实现选型**：**走 HTTP**（与 `check_inbox.ts:27` 风格一致），调 `GET ${env.hubUrl}/api/messages/:id?markRead=true`。
Why：保持 MCP tool 层"瘦"，DAO 操作留在后端 HTTP 层，tool 可独立单测（mock fetch）。

**完成判据**：
- `tsc --noEmit` 通过
- 单测 mock HTTP：200 / 404 / 403 / 500 四种路径各一条
- 不 import `db/` 任何模块
- README 列出 HTTP 调用路径和错误码

---

### Wave 1 交付锁

- 以上 4 个模块**必须全部完成**（代码 + 单测通过 + README），Wave 2 才能启动
- Leader 验证：`ls packages/backend/src/comm/{envelope,envelope-builder,message-store}.ts packages/backend/src/mcp/tools/read_message.ts` 全部存在
- 编译检查：`pnpm -C packages/backend tsc --noEmit` 零报错

---

## Wave 2 — 业务胶水（串接 W1 模块，部分并行）

W2 共 10 个模块，按依赖分组：

| 组 | 模块 | 可并行 |
|---|------|--------|
| G1（先做） | W2-A / W2-B / W2-J | 三者互不依赖 |
| G2 | W2-C / W2-H | G1 完成后 |
| G3 | W2-D / W2-E / W2-F / W2-G / W2-I | G2 完成后，组内并行 |

---

### W2-A · `bus/subscribers/member-driver/index.ts` + 挂载 bootSubscribers

- **类型**：业务胶水 / 聚合入口
- **代码位置**：`packages/backend/src/bus/subscribers/member-driver/index.ts`（新建）+ 改 `bus/index.ts:29-53`
- **预估行数**：index ~40 / bus/index diff ~10
- **依赖**：`lifecycle.ts` / `replay.ts` / `pid-writeback.ts`（已存在）

**接口契约**：

```typescript
// bus/subscribers/member-driver/index.ts
import { Subscription } from 'rxjs';
import type { EventBus } from '../../events.js';

export interface SubscribeMemberDriverDeps {
  eventBus?: EventBus;
  // 允许 Stage 测试注入 fake registry / runtime（见 lifecycle 签名）
  registry?: import('../../../agent-driver/registry.js').DriverRegistry;
  runtime?: import('../../../process-runtime/types.js').ProcessRuntime;
  hubUrl?: string;
  commSock?: string;
}

/**
 * 聚合 lifecycle + pid-writeback 两个 subscription。
 * （replay 是纯函数，由 lifecycle 内部 await，不在这里）
 */
export function subscribeMemberDriver(deps?: SubscribeMemberDriverDeps): Subscription;
```

**bus/index.ts diff**（在 `masterSub.add(subscribeTeam(eventBus))` 之后、sandbox 之前）：

```typescript
import { subscribeMemberDriver } from './subscribers/member-driver/index.js';
// ...
masterSub.add(subscribeMemberDriver({ eventBus }));
```

**Why**：
- `lifecycle.ts` 自身订阅 `instance.created/deleted/offline_requested`，但上层没人调它 → 成员 driver 永远起不来（**断线 #1 #3**）
- `index.ts` 把 `subscribeMemberDriverLifecycle + subscribePidWriteback` 打包成一个 `Subscription`，bus 侧只需一行 `add`

**完成判据**：
- 删掉 `subscribeMemberDriver` 调用行后，**集成测试 U-60 / U-62 失败**（证明挂接真实生效，而不仅仅是编译期摆设）
- 同时验证 `bus/index.ts` snapshot 包含 `import { subscribeMemberDriver } from './subscribers/member-driver/index.js'` 和 `masterSub.add(subscribeMemberDriver(...))` 两行
- 端到端测试：发 `instance.created` → FakeRuntime spawn → `driver.started` 事件 → `role_instances.session_pid` 被写
- `instance.offline_requested` / `instance.deleted` → driver.stop 被调（U-62）
- README：时序图 "bootSubscribers → index → lifecycle/pid-writeback" + 为什么 replay 不在这里

---

### W2-B · `http/server.ts` 接入 driverDispatcher

- **类型**：业务胶水 / 启动链
- **代码位置**：`packages/backend/src/http/server.ts:55-66`
- **预估行数**：diff ~15
- **依赖**：`comm/driver-dispatcher.ts`（已存在）

**改造点**：

```typescript
// server.ts:55 附近
import { createDriverDispatcher } from '../comm/driver-dispatcher.js';
import { driverRegistry } from '../agent-driver/registry.js';

// 在 new CommServer() 之前（或构造时注入）
const dispatcher = createDriverDispatcher(driverRegistry);
const comm = new CommServer({ driverDispatcher: dispatcher }); // 需要先改 CommServer 构造函数
```

**子改动**：`packages/backend/src/comm/server.ts` 构造函数要把 `driverDispatcher` 透传给 `CommRouter`（现状 CommServer 直接 new 一个 Router，没暴露此参数）。**需要读 comm/server.ts 确认**。

**Why**：当前 `CommServer` 里 `new CommRouter({ registry: this.registry })` 没传 dispatcher，router.ts:79-91 的 driver 分支永远走不到 → `send_msg` 对在线对端只能靠 `socket.write`（CommClient 模式），HTTP MCP 模式下必然 offline（**断线 #2**）。

**完成判据**：
- `send_msg` 对已 activate 的成员 → bus.emit `driver.text` 可见（证明走了 driver.prompt）
- `router.ts` 的 `local-online` 分支日志提示 route by driver
- 不改 `CommRouter` 对外签名（它本来就接收 dispatcher 参数）
- `new CommServer({ driverDispatcher: dispatcher })` 构造时注入；`CommServer` 类新增 `constructor(opts: {driverDispatcher?: DriverDispatcher} = {})`（若 server.ts 目前无此 opts）
- **集成测试 I-02**：启动 HTTP server 后读 `comm.router` 内部字段或用行为反推断言 dispatcher 已注入（**不能靠手测**）

---

### W2-J · `db/schemas/messages.sql` 扩列 + 实装迁移逻辑

- **类型**：业务 / DB 迁移
- **代码位置**：
  - `packages/backend/src/db/schemas/messages.sql`（新表定义）
  - **必须新建** `packages/backend/src/db/migrations/2026-04-25-messages-envelope.ts`（迁移脚本）
  - `packages/backend/src/db/connection.ts` 在 `applySchemas()` 之后调用迁移 runner
- **预估行数**：schema 改 +15 行 / 迁移脚本 ~80 行 / connection.ts diff ~10 行
- **依赖**：无

**审查修订（v2）**：
- 当前 `db/connection.ts:23-34` 只是把 `schemas/*.sql` 合并 exec。`CREATE TABLE IF NOT EXISTS` 对老库（已有 messages 表）**不会补列**。
- 仅改 schema 文件**不够**，必须新增一层"运行时 migration"来 ALTER TABLE 老库。
- 参考现有 `schema_version` 表（`recordVersion()`），把 SCHEMA_VERSION 提到 2，v2 migration 只对 v1 库执行一次。

**改造点**：

schema 文件更新为 v2 形态：

```sql
CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  -- v1 字段（保留）
  from_instance_id TEXT REFERENCES role_instances(id) ON DELETE SET NULL,
  to_instance_id   TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  team_id          TEXT REFERENCES teams(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','task','broadcast','system')),
  summary          TEXT NOT NULL DEFAULT '',
  content          TEXT NOT NULL,
  sent_at          TEXT NOT NULL,
  read_at          TEXT,
  reply_to_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  -- v2 新增
  from_kind        TEXT NOT NULL DEFAULT 'agent' CHECK(from_kind IN ('user','agent','system')),
  from_user_id     TEXT,
  from_display     TEXT NOT NULL DEFAULT '',
  to_kind          TEXT NOT NULL DEFAULT 'agent' CHECK(to_kind IN ('user','agent','system')),
  to_display       TEXT NOT NULL DEFAULT '',
  envelope_uuid    TEXT NOT NULL DEFAULT '',
  attachments_json TEXT
);

-- 索引（含新增）
CREATE INDEX IF NOT EXISTS idx_msg_to_unread ON messages(to_instance_id, sent_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_msg_to        ON messages(to_instance_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_from      ON messages(from_instance_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_team      ON messages(team_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_reply     ON messages(reply_to_id);
CREATE INDEX IF NOT EXISTS idx_msg_from_kind ON messages(from_kind, sent_at DESC);
-- envelope_uuid UNIQUE 索引在 backfill 完成后的 migration 最后一步建立
```

migration 脚本伪代码：

```typescript
// migrations/2026-04-25-messages-envelope.ts
export function migrateMessagesEnvelope(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  const has = (n: string) => cols.some(c => c.name === n);
  const stmts: string[] = [];
  if (!has('from_kind')) stmts.push("ALTER TABLE messages ADD COLUMN from_kind TEXT NOT NULL DEFAULT 'agent' CHECK(from_kind IN ('user','agent','system'))");
  if (!has('from_user_id')) stmts.push("ALTER TABLE messages ADD COLUMN from_user_id TEXT");
  // ... 其余列同理
  if (!has('envelope_uuid')) stmts.push("ALTER TABLE messages ADD COLUMN envelope_uuid TEXT NOT NULL DEFAULT ''");
  if (!has('attachments_json')) stmts.push("ALTER TABLE messages ADD COLUMN attachments_json TEXT");
  for (const s of stmts) db.exec(s);

  // backfill（只有执行了 ALTER 才做）
  if (stmts.length > 0) {
    db.exec("UPDATE messages SET envelope_uuid = 'msg_' || id WHERE envelope_uuid = '' OR envelope_uuid IS NULL");
    db.exec("UPDATE messages SET from_kind = 'system' WHERE from_instance_id IS NULL AND from_kind = 'agent'");
  }

  // UNIQUE 索引（backfill 后安全建立）
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_env_uuid ON messages(envelope_uuid)");
}
```

connection.ts 接线（在 `applySchemas(db)` 之后、`recordVersion(db)` 之前）：

```typescript
import { migrateMessagesEnvelope } from './migrations/2026-04-25-messages-envelope.js';
// ...
applySchemas(db);
migrateMessagesEnvelope(db);  // 幂等
recordVersion(db);
```

> 注意：`SCHEMA_VERSION` 先不用升到 2（避免触发别处 version 分支）。migration 内部用 `PRAGMA table_info` 判断是否需要跑，已经是幂等的。

**完成判据**（REGRESSION §2.9 U-150 ~ U-156 全过）：
- 新库 `CREATE TABLE IF NOT EXISTS` 直接带全部 v2 列
- 老库（预置 v1 版表 + 1 行数据）运行迁移后：新列存在、envelope_uuid 非空、`from_kind='system'`（针对系统消息行）
- UNIQUE 索引生效（重复 envelope_uuid 插入抛错）
- 连续 boot 两次幂等（不抛异常、不重复 ALTER、不覆盖现有值）
- 插 `from_kind='other'` 抛 CHECK 违约
- README 记录 "首次启动自动迁移；回退删除新列 + DROP INDEX idx_msg_env_uuid 即可"

---

### W2-C · `comm/router.ts` 改吃 Envelope + 同步落库 + 老事件兼容

- **类型**：业务 / 核心路由
- **代码位置**：`packages/backend/src/comm/router.ts:50-105`
- **预估行数**：改造后 ≤ 200（若超 200 必须拆：把 notify 拼接、bus emit 小工具抽到 `router-helpers.ts`）
- **依赖**：W1-A / W1-C（store 同步落库）

**改造点**（v2 修订）：
- `dispatch(msg: Message)` → `dispatch(env: MessageEnvelope)`
- 入口第一步：**router 内同步调 `messageStore.insert(env)`**，保证 envelope.id 落库成功后才往下走（不走 subscriber 异步）
- 落库成功后 `bus.emit('comm.message_sent', { messageId: env.id, from: env.from.address, to: env.to.address })`（**沿用老事件**，payload 不扩）
- 三叉分支（system / driver / socket）保持；driver 分支调 dispatcher 前 router 自己拼 `notifyLine = formatNotifyLine({envelopeId: env.id, fromDisplayName: env.from.displayName, summary: env.summary})`
- driver 分支 `delivered` 后 `bus.emit('comm.message_received', { messageId, from, to, route:'driver' })`
- `extractText`（router.ts:26-32）删除
- `offline.store` 调用删除（落库已在入口同步完成；offline 分支只标记 `stored: true`）
- 保留 `replay(address)` 方法，内部实现改为 `messageStore.findUnreadFor(...)` + `formatNotifyLine`

**Why 不走 `comm.message_delivered` subscriber**：
- driver.prompt 里已经带了 `[msg_id=<id>]`，agent 可能在下一次 turn 立即调 `read_message`。若落库在 subscriber 异步进行，DB 行可能还没入 → 404。
- Part B 前端设计文档（`comm-model-frontend.md` §6.2）明确采用"WS 推 messageId + HTTP 反查"，**拒绝**扩 bus payload。新增 `comm.message_delivered` 会制造前后端契约分裂。
- router 内同步 insert 性能完全够用（单次 prepared statement，同一进程 < 1ms），不需要解耦。

**完成判据**：
- `dispatch` 参数类型是 `MessageEnvelope`，TSC 能捕获老调用点（`server.ts:139` / `mcp-http/in-process-comm.ts:42` / `bus/subscribers/comm-notify.subscriber.ts:23,57` 均需同步改造）
- 5 条路径单测：system / driver-delivered / driver-not-ready-fallthrough / remote-unsupported / dropped
- **落库入口唯一性测试**：用 spy store 断言 "成功路径（system / online / offline）insert 恰好一次；dropped / remote-unsupported 不调 insert"
- **bus 事件计数**：每条成功 dispatch 对 `comm.message_sent` emit 恰好一次（不漏不重）；`delivered` 路径额外 emit 一次 `comm.message_received`
- **notify 行格式正则**：dispatcher 收到的 text 严格匹配 `^@[^>]+>.+  \[msg_id=msg_[A-Za-z0-9_-]+\]$`
- `extractText` 函数在最终代码里消失（grep 零匹配）
- README 时序图 + 竞态：落库 → emit → 路由三步的时序保证；并发 dispatch 同 envelope_uuid（理论不会出现）的幂等兜底

---

### W2-H · `bus/types.ts` 字段冻结 + ws 白名单不漂移（v2 缩小范围）

- **类型**：非业务 / 契约校验
- **代码位置**：`packages/backend/src/bus/types.ts:99-112` + `bus/subscribers/ws.subscriber.ts:11-46`
- **预估行数**：diff = 0（本期**不改 bus 类型**）
- **依赖**：W1-A（仅 import type，用于 router 内部类型）

**审查修订（v2）**：
- 原 v1 提出新增 `comm.message_delivered` 事件，被前端设计文档（`comm-model-frontend.md` §6.2）明确拒绝。改为**沿用老事件、payload 0 改动**。
- 本任务退化为"守门"：写一条测试断言 `BusEventType` 联合中**不包含** `comm.message_delivered`，`WS_EVENT_TYPES` 数量仍为基线值（34）。防止下一个 agent 再次偏离。

**保留现有**：
- `comm.message_sent` 字段 `{messageId, from, to}` 冻结
- `comm.message_received` 字段 `{messageId, from, to, route}` 冻结

**Why 冻结**：
- 前端按"WS 推 messageId + HTTP 反查 envelope"方案稳定运行（见 Part B §6.3）
- 扩 payload 会让所有现有订阅者重新声明类型
- 未来若真要推 envelope，走**独立 WS channel**（非 bus 层），而不是污染 bus 契约

**完成判据**：
- `tsc --noEmit` 通过
- 新增一条断言测试：`BusEventType` 联合不含 `'comm.message_delivered'`；`WS_EVENT_TYPES.size === 34`（或当前基线）
- 无代码改动留痕（`git diff bus/types.ts bus/subscribers/ws.subscriber.ts` 为空）

---

### W2-D · `mcp/tools/send_msg.ts` 改造

- **类型**：业务 / 工具
- **代码位置**：`packages/backend/src/mcp/tools/send_msg.ts`
- **预估行数**：重写后 ~90
- **依赖**：W1-A / W1-B（builder 在 CommLike.send 侧调用）

**改造点**（对齐 `comm-model-design.md` §3.1）：

- `summary` 变可选（缺省 "给你发了一条消息"）
- 新增 `kind`（enum: chat/task/broadcast，**禁 system**）
- 新增 `replyTo`
- 返回 `{ delivered: true, messageId, route } | { error }`
- `from` 依然由 `CommLike.send` 的 `selfAddress` 强注入（不改这段），调用方无法伪造

**完成判据**：
- schema JSON 对齐设计文档 §3.1
- 单测：缺 summary 成功 / 缺 content 失败 / kind='system' 失败 / replyTo 透传
- 返回结构 `messageId` 可被同流程 `read_message` 拉到
- README 列"和旧 schema 的兼容性"：老客户端传 `summary+content` 仍可用

---

### W2-E · `comm/driver-dispatcher.ts` 签名冻结（0 代码改动）

- **类型**：非业务 / 契约校验
- **代码位置**：`packages/backend/src/comm/driver-dispatcher.ts`
- **预估行数**：diff = 0（**本任务不改代码**）
- **依赖**：无

**审查修订（v2）**：
- 原 v1 说"参数名 `text` → `notifyLine`"。参数名修改对调用方无意义（TS 按类型不按名匹配），属于无效劳动。
- 维持 **`DriverDispatcher = (id: string, text: string) => Promise<Result>`** 签名不变。拼接 notifyLine 由 W2-C 的 router 完成（router 持有 envelope，调 `formatNotifyLine(...)` 然后原样 `dispatcher(id, notifyLine)`）。
- 如果实现者想动 `text`，在 `driver-dispatcher.README.md` 留一句"语义上是 notifyLine"即可。

**Why 签名冻结**：
- `INTERFACE-CONTRACTS.md` 里 DriverDispatcher 接口明确冻结（见 `packages/backend/docs/phase-sandbox-acp/INTERFACE-CONTRACTS.md` §4）
- dispatcher 是非业务模块，入口一旦漂移会级联污染成员测试

**完成判据**：
- `git diff packages/backend/src/comm/driver-dispatcher.ts` 为空
- 可选：`driver-dispatcher.README.md` 补一句 "router 传入的 text 在 v2 起是 notifyLine（形如 `@<name>>${summary}  [msg_id=...]`）"
- 单测 U-110 ~ U-114 验证行为（不变）

---

### W2-F · `format-message.ts` + `check_inbox.ts` + `replay.ts` 改造

- **类型**：业务 / 展示层
- **代码位置**：
  - `packages/backend/src/member-agent/format-message.ts`
  - `packages/backend/src/mcp/tools/check_inbox.ts`
  - `packages/backend/src/bus/subscribers/member-driver/replay.ts`（v2 新增：必须一起改）
- **预估行数**：format ~50 / check_inbox ~30 / replay 改动 ~30
- **依赖**：W1-A + W1-C（replay 改走 `messageStore.findUnreadFor`）

**format-message 改造**（对齐 `comm-model-design.md` §3.4）：

```typescript
export interface FormatNotifyInput {
  envelopeId: string;
  fromDisplayName: string;
  summary: string;
}
export function formatNotifyLine(input: FormatNotifyInput): string {
  return `@${input.fromDisplayName}>${input.summary}  [msg_id=${input.envelopeId}]`;
}

/** @deprecated shim；内部 delegate 到 formatNotifyLine。下一个 Phase 删。 */
export function formatMemberMessage(/* 原签名 */): string;
```

**check_inbox 改造**：
- 仍调 `/api/role-instances/:id/inbox`（由 W2-I 实装）
- 返回 `{ messages: InboxSummary[], total }`（不含 content）
- schema 不变（仍只有 peek 参数）

**replay.ts 改造（审查新增）**：
- 现状 `replay.ts:50-76` 走老的 `offline.replayFor` + `formatMemberMessage` → 拼成"[来自 xxx] summary\n\ncontent"格式，**没有 msg_id**。老消息上线回灌时 agent 无法调 `read_message` 拿全文，直接违反用户目标。
- v2：
  - `offline.replayFor(address)` → `messageStore.findUnreadFor(toInstanceId)`（返回 `MessageEnvelope[]`）
  - `formatMemberMessage(...)` → `formatNotifyLine({envelopeId: env.id, fromDisplayName: env.from.displayName, summary: env.summary})`
  - `offline.markDelivered(msg.id)` → `messageStore.markRead(env.id)`
- 保留 `ReplayResult` 形状；内部改实现。
- lifecycle.ts 的调用点 `replayForDriver(instanceId, driver)` 不变（签名不漂移）。

**Why replay 也要改**：
- 回灌场景同样属于"agent 收到消息只看通知"范畴——用户需求 #5 没给例外
- 不改 replay 会出现"在线消息一种格式、离线消息另一种格式"的分裂

**completion**：
- `formatNotifyLine` 产出字符串严格匹配正则 `^@[^>]+>.+  \[msg_id=msg_[a-zA-Z0-9_-]+\]$`
- replay 的 E-06 场景（REGRESSION §4）通过：成员离线时发 2 条 → activate → 2 条 driver.prompt 都带 msg_id
- `offline.ts` 仅保留 `replayFor` 作读兜底；`offline.store` 被 router 吃掉后作为 shim（见 W2-C）
- README 明确 shim 删除条件（"W3 回归全绿后的下一个 PR"）

---

### W2-G · ~~message-persister subscriber~~ ⛔ 取消（v2）

**审查修订**：本任务取消。理由详见 W2-C：
- driver.prompt 里已经带 `[msg_id=<id>]`，agent 下一轮立即调 `read_message` 要求 DB 已有记录。subscriber 异步写库导致 404 风险（REGRESSION I-17 专门验）。
- 持久化并入 W2-C：router 入口同步调 `messageStore.insert(env)`。
- 不新增 `comm.message_delivered` 事件（见 W2-H 审查说明）。
- 若未来要把落库解耦出 router，走"**本地同步先落库 + 后置 audit subscriber**"模式，而不是把主写入路径交给 subscriber。

本节保留编号为历史记录；下游实现者**不要**新建 `message-persister.subscriber.ts`。

---

### W2-I · `http/routes/messages.routes.ts`（新增）

- **类型**：业务 / HTTP
- **代码位置**：`packages/backend/src/http/routes/messages.routes.ts`（新建）+ `http/router.ts` 挂载（加入 handlers 数组）
- **预估行数**：≤ 200（若含校验 + to 补全超 200，**必须拆**：把"body schema 校验"抽到 `messages.schema.ts`，把"to 字段 lookup 补全"抽到 `messages.lookup.ts`）
- **依赖**：W1-B / W1-C + 现有 `api/panel/role-instances`

**需要实现的端点**（对齐前端文档 §7.6）：

| 方法 | 路径 | handler |
|------|------|---------|
| POST | `/api/messages/send` | 校验 body → lookup 补全 `to` → buildEnvelope（fromKind='user'）→ CommRouter.dispatch → 返回 `{messageId}` |
| GET  | `/api/messages/:id` | `MessageStore.findById`；`?markRead=true` → `markRead` |
| GET  | `/api/role-instances/:id/inbox?peek=` | `MessageStore.listInbox` |
| GET  | `/api/teams/:teamId/messages?before=&limit=` | `MessageStore.listTeamHistory` |

**POST body schema**（对齐 `comm-model-frontend.md` §7.1）：
- 必填：`to: { kind: 'agent'\|'user', address: string }` + `content: string`
- 可选：`summary`（默认 "给你发了一条消息"）/ `kind`（不允许 `'system'`）/ `replyTo` / `attachments`
- **忽略**：body 里的 `from` 字段（强注入为 user）

**`to` 补全逻辑**（Part B §7.1 前端请求 #3）：
- 前端只传 `to.address`，后端反查 `role_instances`：根据 `parseAddress(to.address).id` → `RoleInstance.findById` → 得到 `memberName / alias`
- 补全后的 `to.displayName` 优先 alias，其次 memberName
- 查不到 → `404 { error: "to not found: <address>" }`
- 前端若主动传齐 `displayName / instanceId / memberName`，以 body 为准（后端做一致性校验，instanceId 与 address 解析结果不匹配 → 400）

**Why POST 的 from 不可传**：`comm-model-design.md` §6 强注入约束 —— HTTP 入口的 envelope 一定 `from.kind='user'`。body 里的 `from` 字段忽略（不报错，仅 stderr warn）。

**`to.kind` 白名单**：当前期只允许 `'agent'`。`'user'` / `'system'` 返回 400（与前端 Part B 反向请求 #4 一致）。

**完成判据**：
- 四条 route 单测各覆盖 200 / 400 / 404 / 415 一条
- `POST /send` body 带 `from` 字段 → 被后端覆盖为 user（日志有 warn）
- `POST /send` body `to: {kind:'agent', address:'local:inst1'}` 最小形式 → 能成功路由且 DB 写入的 to_display 由后端填
- `GET :id?markRead=true` → 实际写 DB；默认（不带 query）**不**改 read_at
- `http/router.ts` handlers 数组中增加 `handleMessagesRoute`
- README：路径 + 请求体 + 响应体示例 + curl 样例

---

### W2-K · 旧调用点同步改造（审查新增）

- **类型**：业务胶水 / 调用点迁移
- **代码位置**：
  - `packages/backend/src/bus/subscribers/comm-notify.subscriber.ts:23-40,56-73`（两处 `router.dispatch(msg: Message)` 调用）
  - `packages/backend/src/mcp-http/in-process-comm.ts:33-49`（`router.dispatch(msg)` 调用）
  - `packages/backend/src/comm/server.ts:138-147`（socket message 走 `router.dispatch(msg)` 调用）
- **预估行数**：comm-notify diff ~40 / in-process-comm diff ~30 / server diff ~15
- **依赖**：W1-A / W1-B / W2-C

**改造点**：dispatch 参数改 envelope 后，这四处调用必须同步改：

1. **comm-notify.subscriber.ts**：在调 `router.dispatch` 前用 `buildEnvelope({ fromKind: 'system', fromAddress: 'local:system', ... }, { allowSystemKind: true })`。
2. **in-process-comm.ts**：`CommLike.send` 不直接构造 `Message`，改在 InProcessComm 内调 envelope-builder（`fromKind='agent'`，从 `selfAddress` 取 instanceId）。
3. **server.ts** `handleLine`：socket 收到 `msg.type==='message'`，同上 `fromKind='agent'`，先 build envelope 再 dispatch。
4. **CommClient.send**（`mcp/comm-client.ts:109-123`）：stdio 模式下 CommClient 走 socket 发 Message 到 server.ts，server.ts 侧 build envelope 即可，CommClient 自身**不用改**。

**Why 必须列清**：TS 类型改动会直接让这几个点编译失败，但"改到哪一层算 envelope 边界"需要明确。原 TASK-LIST 只列了前两处，漏了 `comm-notify.subscriber.ts` 的两处系统消息 emit——漏了系统消息的 envelope 构造就违反 §6 强注入约束（系统消息 `from.kind='system'`）。

**完成判据**：
- `tsc --noEmit` 在这 4 个文件零错
- I-05（系统消息走强注入）通过：subscribeCommNotify 产出的 envelope `from.kind='system'`、`from.address='local:system'`、通知行显示 `@系统>...`
- 不 grep 到残留 `router.dispatch(msg: Message)` / `router.dispatch({type:'message',...})` 调用

---

## Wave 2 交付锁

- W2 所有 ~~10~~ **11** 个模块（含 W2-K，**不含取消的 W2-G**）+ 对应测试通过
- `bun run tsc --noEmit` 零报错
- `bun test` 全绿
- README 齐全（业务模块必有时序图）

---

## Wave 3 — 回归测试

见 `REGRESSION.md`，测试员进场。

---

## 变更日志

| 日期 | 改动 | 作者 |
|------|------|------|
| 2026-04-25 | 初版 | arch-comm-a |
| 2026-04-25 | v2 对抗审查修订：<br>1. W2-C：持久化从 subscriber 异步 → router 内同步 `store.insert`（修 `msg_id 落 DB 竞态`）<br>2. W2-G：**取消** message-persister subscriber（与 v1 W2-C 协同问题）<br>3. W2-H：**取消**新增 `comm.message_delivered` 事件，与 Part B `comm-model-frontend.md` §6.2 对齐（前端反对扩 bus payload）；本任务退化为"契约冻结守门"<br>4. W2-E：签名 0 改动（原方案改参数名无意义）<br>5. W2-F：**加码**改 `replay.ts`，否则离线消息回灌走老格式，agent 拿不到 msg_id<br>6. W2-J：**实装** migration runner（`db/connection.ts` 现状只合并 SQL 文件，CREATE TABLE IF NOT EXISTS 不补列）<br>7. W2-I：补 `to` 字段 lookup 补全需求；`to.kind` 白名单限 `'agent'`<br>8. W2-K：**新增**，列清 4 处旧 `router.dispatch(Message)` 调用点（comm-notify 系统消息等）<br>9. W1-D：澄清 `import type` 不算运行时依赖<br>10. REGRESSION.md 补全（53 条用例） | reviewer-comm-a |
