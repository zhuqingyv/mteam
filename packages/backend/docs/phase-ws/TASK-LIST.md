# Phase WS · 模块清单

> Wave 1（非业务，并行）→ Wave 2（业务胶水，部分并行）→ Wave 3（回归测试）
>
> 每个模块交付物：代码（单文件 ≤ 200 行）+ `*.test.ts`（不 mock db/bus）+ `README.md`。

---

## Wave 1 · 非业务模块（8 件，并行）

### W1-A · `ws/protocol.ts` —— WS 协议消息类型

**代码位置**: `packages/backend/src/ws/protocol.ts`（新文件）

**职责**：只定义类型，不含运行时逻辑；任何 ws/* 下的文件靠 `import type` 吃这份契约。

**接口契约**：

```typescript
// 上行消息（前端 → 后端）
export type WsUpstream =
  | { op: 'subscribe'; scope: SubscriptionScope; id?: string; lastMsgId?: string }
  | { op: 'unsubscribe'; scope: SubscriptionScope; id?: string }
  | { op: 'prompt'; instanceId: string; text: string; requestId?: string }
  | { op: 'ping' };

// 下行消息（后端 → 前端）
export type WsDownstream =
  | { type: 'event'; id: string; event: WsEventPayload }
  | { type: 'gap-replay'; items: Array<{ id: string; event: WsEventPayload }>; upTo: string | null }
  | { type: 'pong'; ts: string }
  | { type: 'ack'; requestId: string; ok: boolean; reason?: string }
  | { type: 'error'; code: WsErrorCode; message: string };

export type SubscriptionScope = 'global' | 'team' | 'instance' | 'user';

export type WsErrorCode =
  | 'bad_request'      // JSON parse 失败 / schema 不合法
  | 'not_found'        // 订阅的 team/instance 不存在
  | 'forbidden'        // 用户无权订阅 / prompt（跨 user）
  | 'not_ready'        // prompt 到的 driver 还没 READY
  | 'internal_error';

/** bus 事件 → WS payload 的序列化结果，来自 toWsPayload(event) 剥离 source/correlationId 后 */
export type WsEventPayload = Record<string, unknown>;

/** 类型守卫：校验上行 JSON。调用方应在解析失败时回 error 消息，而不是 throw。 */
export function isWsUpstream(x: unknown): x is WsUpstream;
```

**依赖**: 无（纯类型 + 1 个类型守卫）。

**预估行数**: 约 90 行（含守卫与注释）。

**完成判据**：
1. 文件存在、行数 ≤ 200；TypeScript 编译通过。
2. `import type { WsUpstream, WsDownstream } from '../ws/protocol.js'` 在其他模块里能用。
3. `isWsUpstream({op:'subscribe',scope:'team',id:'t1'}) === true`。
4. `isWsUpstream({op:'foo'}) === false`。
5. 配套 `protocol.test.ts` 覆盖：守卫对 4 种 op 的所有必填字段；反例至少 6 种（op 错拼、scope 不在枚举、id 类型错、lastMsgId 不是 string、带多余字段、null 输入）。
6. README.md 说明「为何上下行分 type 键」、「requestId 用途（prompt 回 ack）」、「lastMsgId 必须是字符串不是数字」。

---

### W1-B · `ws/subscription-manager.ts` —— per-connection 订阅状态

**代码位置**: `packages/backend/src/ws/subscription-manager.ts`（新文件）

**职责**：纯数据结构管理每条 WS 连接的订阅集合。不依赖 bus、不依赖 DB、不调 network。

**接口契约**：

```typescript
import type { BusEvent } from '../bus/types.js';
import type { SubscriptionScope } from './protocol.js';

export interface ClientSubscription {
  scope: SubscriptionScope;
  /** global 时固定为 null；team/instance/user 时为目标 id */
  id: string | null;
}

export interface ConnectionRecord {
  readonly connectionId: string;
  readonly subs: Set<string>;  // 序列化形如 "team:team_01" / "global:" / "user:u1"
}

export class SubscriptionManager {
  /** 初始化空记录；WS 连接建立即调。 */
  addConn(connectionId: string): void;
  /** 断开时调用；返回 true 表示确实移除过。 */
  removeConn(connectionId: string): boolean;

  subscribe(connectionId: string, sub: ClientSubscription): void;
  unsubscribe(connectionId: string, sub: ClientSubscription): void;

  /**
   * 判断某个事件是否命中连接的订阅集合。
   * match 规则（按优先级）：
   *   - 该连接 subscribed 'global:' → 任何事件命中
   *   - event 有 instanceId/driverId 且 subscribed 'instance:<id>' → 命中
   *   - event 有 teamId 且 subscribed 'team:<id>' → 命中
   *   - event 是 comm.* 且 envelope.to 是 user:<id> 且 subscribed 'user:<id>' → 命中
   *   - 其他 → drop
   *
   * 本函数是纯函数，不查 bus、不查 DB。event 形如 bus/types.ts 定义。
   */
  match(connectionId: string, event: BusEvent): boolean;

  /** 调试/测试用 */
  list(connectionId: string): ClientSubscription[];
  stats(): { conns: number; totalSubs: number };
}
```

**依赖**: `import type` from `./protocol.js`、`../bus/types.js`；无运行时依赖。

**预估行数**: 约 140 行。

**完成判据**：
1. 文件 ≤ 200 行；TypeScript 编译通过；import 零运行时依赖（只 `import type`）。
2. `subscription-manager.test.ts` 覆盖：
   - addConn / removeConn 幂等性
   - subscribe 去重（重复 subscribe 同一 scope+id 只记一次）
   - unsubscribe 未订阅过不抛错
   - match 五个规则各 1 个用例 + 1 个反例
   - global 订阅"吞"其他 scope
   - 跨 connection 隔离（A subscribe 不影响 B）
3. README.md 附 match 优先级表与反例；说明为什么 user scope 要匹配 envelope.to 而不是 envelope.from；说明越权校验（id !== ctx.userId）**不**在本模块做，在 ws-handler 做。

---

### W1-D · messages 表 schema 迁移 + `findUnreadForAddress`（B1 阻断）

> **优先级最高**：不做这一步，user address 的 envelope 在 router `store.insert` 第一行就 SQL 错（`to_instance_id NOT NULL`）；整个功能 4（user 注册）和 R4-2 / R4-5 都挂。

**代码位置**:
- `packages/backend/src/db/schemas/messages.sql`（改现有）
- `packages/backend/src/db/migrate.ts`（加一步 ALTER）
- `packages/backend/src/comm/message-store.ts`（扩 `findUnreadForAddress`）

**schema 改动**：

```sql
-- v3（phase-ws W1-D）：to 侧支持 user / system address
-- SQLite 不支持 ALTER COLUMN DROP NOT NULL，用 recreate-via-rename：
--   1) CREATE TABLE messages_new (... to_instance_id TEXT REFERENCES role_instances(id) ON DELETE SET NULL)
--   2) INSERT INTO messages_new SELECT * FROM messages
--   3) DROP TABLE messages; ALTER TABLE messages_new RENAME TO messages
--   4) 重建所有索引
-- 同时新增列：
ALTER TABLE messages ADD COLUMN to_user_id TEXT;  -- to.kind='user' 时填 stripUser(to.address)
CREATE INDEX IF NOT EXISTS idx_msg_to_user ON messages(to_user_id, sent_at DESC);
```

- 新 `to_instance_id` 允许 NULL；外键改 `ON DELETE SET NULL`（不再 CASCADE —— 因为 user/system 没 role_instances 可参照）
- `to_user_id` 非外键（user 表 Phase 2 再建）
- store.insert 写入时：
  - `to.kind='user'` → `to_user_id=stripUser(to.address), to_instance_id=NULL`
  - `to.kind='system'` → `to_instance_id=NULL, to_user_id=NULL, to_display='系统'`
  - `to.kind='agent'` → 既有逻辑（`to_instance_id=env.to.instanceId`）
- backfill：既有全部行 to 都是 agent，无需动；新列默认 NULL 即可

**MessageStore 扩签名**（不改既有，仅加方法）：

```typescript
export interface MessageStore {
  // 既有不变 ...
  /**
   * 按 "to 地址" 找未读。
   * address 形如 'user:u1' / 'local:<instanceId>' / 'local:system'。
   * 比 findUnreadFor(toInstanceId) 通用 —— gap-replayer 用它。
   */
  findUnreadForAddress(address: string): MessageEnvelope[];
}
```

内部实现：`parseAddress(address)`：
- scope='user' → `to_user_id = stripUser(address)`
- scope='local' && id='system' → `to_kind='system' AND to_instance_id IS NULL`
- scope='local' 其他 → 既有 `to_instance_id = id` 分支

**依赖**: phase-comm 已交付的 message-store（不改签名，仅加方法）。

**预估行数**: 约 100 行（SQL 迁移 60 + TS 新方法 40）。

**完成判据**：
1. `messages.sql` 迁移可执行（`bun run migrate` 通过），既有 v2 数据 0 丢失（行数 before/after 对齐）
2. `MessageStore.findUnreadForAddress('user:u1')` 能拿到 to_user_id='u1' 的消息
3. `message-store.test.ts` 新增 3 用例：user 收件、system 收件、instance 收件 各 1
4. `router.dispatch(env)` 对 `env.to.kind='user'` envelope 不抛 SQL 错（用真 DB 集成测试覆盖）
5. README 说明迁移策略（recreate-via-rename 而非 ALTER COLUMN）

> **关于冻结接口**：本 task 扩 `MessageStore` 新增方法，**不改** phase-comm 已冻结签名（insert/findById/markRead/listInbox/listTeamHistory/findUnreadFor 全保留）。属于向前兼容扩展。

---

### W1-C · `ws/gap-replayer.ts` —— 断线 gap 补发

**代码位置**: `packages/backend/src/ws/gap-replayer.ts`（新文件）

**职责**：给定 `lastMsgId + scope`，从 `MessageStore` 查"缺失的消息"并产出一批 `WsDownstream.gap-replay.items`。**纯函数**，不碰 WS 连接本身。

**接口契约**：

```typescript
import type { MessageStore } from '../comm/message-store.js';
import type { ClientSubscription } from './subscription-manager.js';
import type { WsDownstream } from './protocol.js';

export interface GapReplayDeps {
  messageStore: MessageStore;
  /** 防滥用上限；超过后返回 upTo 指向较早位置，前端下次 subscribe 继续拉。 */
  maxItems?: number;  // default 200
}

export interface GapQuery {
  lastMsgId: string | null;
  sub: ClientSubscription;
}

/**
 * 构造 gap-replay 下行消息。若无缺失返回 items=[], upTo=null。
 * scope 语义：
 *   - team:<id>  → messageStore.listTeamHistory
 *   - instance:<id> → messageStore.findUnreadForAddress('local:<id>')
 *   - user:<id>  → messageStore.findUnreadForAddress('user:<id>')（W1-D 新方法）
 *   - global → 不支持 gap（返回 items=[]）；注释说明理由
 *
 * **超量 gap 契约**：单次 gap-replay items 上限 = maxItems（默认 200）。
 *   若实际缺失 > maxItems：只推 maxItems 条，upTo 指向"已推的最老一条 id"；
 *   前端收到后继续 subscribe 并把新 lastMsgId 设为 upTo，翻页拉更老的 gap。
 *   这把"丑但有界"的过渡方案明码标价，可审计可接管。
 */
export function buildGapReplay(deps: GapReplayDeps, q: GapQuery): WsDownstream;
```

**依赖**: `import type` from `./protocol.js`、`./subscription-manager.js`、`../comm/message-store.js`。

**预估行数**: 约 120 行。

**完成判据**：
1. 文件 ≤ 200 行；TS 编译通过。
2. `gap-replayer.test.ts` 用**真实 MessageStore + 真实 DB**（遵循 WORKFLOW §6 不 mock 规则），插 5 条消息，lastMsgId 取中间某条：
   - 只返回该 id **之后**的消息（严格 >）
   - 每条 item.id = envelope.id
   - upTo = 最新一条 id
   - lastMsgId=null 时：items=[]（phase-comm 契约里 listTeamHistory 是游标式，null 视作"无缺"避免首订阅时把全表灌下去）—— README 明确说明
3. `maxItems=3` 插 5 条 gap，返回 items.length=3 且 upTo 指向第 3 条；第二次调用 `lastMsgId=upTo` 再拉出剩 2 条（**翻页契约**）
4. scope='global' 返回空 items
5. scope='user:u1' 用 W1-D 的 `findUnreadForAddress('user:u1')` 拉对应行
6. README.md 附 scope × store 方法映射表 + lastMsgId=null 的行为原因 + 超量 gap 翻页协议

**关于冻结接口不改的妥协**：
- `MessageStore.listTeamHistory` 只有 `before` 游标（历史方向）；gap 想要 after 方向。本期**不改** phase-comm 冻结签名，用 `listTeamHistory(before=null, limit=maxItems+50)` 拉一批再过滤 `id > lastMsgId`，过渡方案，README 注明「待 MessageStore 扩 `after` 游标后切回」。
- 代价：单次最多 maxItems 条，超过靠翻页。arch-ws-b 审查同意。

---

### W1-E · `filter/types.ts` —— 可见性规则类型

**代码位置**: `packages/backend/src/filter/types.ts`（新文件）

**职责**：定义 `VisibilityRule` / `VisibilityDecision` 纯类型；不含逻辑。

**接口契约**：

```typescript
export type ActorPrincipal =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; instanceId: string }
  | { kind: 'system' };

/** 一条规则描述"主体 principal 能否看到目标 target 发出/发给的消息/事件"。 */
export interface VisibilityRule {
  id: string;              // uuid
  principal: ActorPrincipal;
  target: ActorPrincipal | { kind: 'team'; teamId: string };
  /** allow / deny。多条规则时 deny 优先（短路）。 */
  effect: 'allow' | 'deny';
  /** 规则说明，给 UI 展示。 */
  note?: string;
  createdAt: string;
}

export type VisibilityDecision =
  | { decision: 'allow'; byRuleId: string | 'default_allow' }
  | { decision: 'deny';  byRuleId: string };

/** DAO 抽象（由 filter-store 实现）。 */
export interface FilterStore {
  list(): VisibilityRule[];
  listForPrincipal(p: ActorPrincipal): VisibilityRule[];
  upsert(rule: VisibilityRule): void;
  remove(id: string): void;
}
```

**依赖**: 无。

**预估行数**: 约 70 行。

**完成判据**：
1. 文件 ≤ 200 行；编译通过。
2. `filter/types.test.ts`：仅对 discriminated union 做类型级断言（`expectTypeOf`）即可，无运行时。
3. README.md：说明为什么不把"principal 是 team"作为主体（team 不是可观测主体，只有 user/agent 看消息；team 作为目标合理）。

---

### W1-F · `filter/filter-store.ts` —— visibility_rules 表 DAO

**代码位置**: `packages/backend/src/filter/filter-store.ts`（新文件）
**迁移**: `packages/backend/src/db/schemas/visibility_rules.sql`（新文件）

**职责**：`FilterStore` 接口的 SQLite 实现。纯 DAO。

**schema**（全新表，不 ALTER 旧表）：

```sql
CREATE TABLE IF NOT EXISTS visibility_rules (
  id              TEXT PRIMARY KEY,
  principal_kind  TEXT NOT NULL CHECK(principal_kind IN ('user','agent','system')),
  principal_ref   TEXT,   -- userId / instanceId，system 为 NULL
  target_kind     TEXT NOT NULL CHECK(target_kind IN ('user','agent','system','team')),
  target_ref      TEXT,
  effect          TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_filter_principal ON visibility_rules(principal_kind, principal_ref);
CREATE INDEX IF NOT EXISTS idx_filter_target    ON visibility_rules(target_kind, target_ref);
```

**接口**：实现 W1-E 的 `FilterStore`；内部用 prepared statements。

**依赖**: `import type { VisibilityRule, FilterStore, ActorPrincipal } from './types.js'` + `getDb` from `../db/connection.js`。

**预估行数**: 约 150 行（含 row↔rule 映射）。

**完成判据**：
1. 文件 ≤ 200 行；TS 编译通过；`import` 清单不含 `bus/*`、`comm/*`、`filter/visibility-filter.ts`。
2. `filter-store.test.ts` 用真 DB：upsert → list → remove → list 各种场景；listForPrincipal 命中/不命中。
3. SQL 迁移在 `db/migrate.ts` 启动时加载（由 W2-4 胶水负责引入；本模块只交付 schema 文件 + DAO）。
4. README.md 附 schema、DAO 方法表、"为何 principal_ref 允许 NULL"（system principal 时）。

---

### W1-G · `notification/types.ts` —— 通知 + 代理模式类型

**代码位置**: `packages/backend/src/notification/types.ts`（新文件）

**职责**：纯类型。

**接口契约**：

```typescript
export type ProxyMode = 'proxy_all' | 'direct' | 'custom';

export interface NotificationConfig {
  id: string;                // 单用户场景固定 'default'
  userId: string | null;     // null = 系统缺省
  mode: ProxyMode;
  /** mode='custom' 时的规则，按顺序匹配。 */
  rules?: CustomRule[];
  updatedAt: string;
}

export interface CustomRule {
  /** 匹配 bus 事件 type；支持 * 通配后缀，如 'team.*'。 */
  matchType: string;
  /** 匹配命中时的目标接收方。 */
  to:
    | { kind: 'user'; userId: string }
    | { kind: 'agent'; instanceId: string }
    | { kind: 'primary_agent' }
    | { kind: 'drop' };       // 显式忽略
}

/** 系统可通知的事件类型白名单（不在此列表不走通知系统，仅走普通 WS 订阅）。 */
export const NOTIFIABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'instance.created',
  'instance.deleted',
  'instance.offline_requested',
  'team.created',
  'team.disbanded',
  'team.member_joined',
  'team.member_left',
  'container.crashed',
  'driver.error',
]);

export interface NotificationStore {
  get(userId: string | null): NotificationConfig;  // 无配置时返 default
  upsert(cfg: NotificationConfig): void;
}
```

**预估行数**: 约 80 行。

**完成判据**：
1. 文件 ≤ 200 行；TS 编译通过。
2. `notification/types.test.ts`：类型断言 + `NOTIFIABLE_EVENT_TYPES` 尺寸断言（与 bus/types.ts 同类事件对齐）。
3. README.md：三种 mode 的语义 + custom rule 匹配算法（自顶向下首命中，全不命中 → drop）。

---

### W1-H · `notification/notification-store.ts` —— 通知配置 DAO

**代码位置**: `packages/backend/src/notification/notification-store.ts`（新文件）
**迁移**: `packages/backend/src/db/schemas/notification_configs.sql`（新文件）

**schema**：

```sql
CREATE TABLE IF NOT EXISTS notification_configs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,                                        -- NULL = 系统 default
  mode       TEXT NOT NULL CHECK(mode IN ('proxy_all','direct','custom')),
  rules_json TEXT,                                        -- CustomRule[] 序列化
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_user ON notification_configs(user_id);
```

**接口**：实现 W1-G 的 `NotificationStore`。

**预估行数**: 约 110 行。

**完成判据**：
1. 文件 ≤ 200 行；TS 编译通过；不 import `bus/*` `comm/*` `ws/*`。
2. `notification-store.test.ts` 用真 DB：upsert custom 规则后 get 回来完整相等；rules_json 解析失败回退 default。
3. README.md：默认配置（`{mode:'direct'}`）由 store 内部 ensure；不要求调用方自行插入。

---

## Wave 2 · 业务胶水（6 件）

> 前置：W1-A 到 W1-H 全部 merge 后才能开 Wave 2。各胶水允许并行但 W2-2 依赖 W2-1（都 touch ws-handler 的 context 对象），建议 W2-1 先走半步再放 W2-2。

### W2-1 · `ws/ws-handler.ts` —— 上行消息路由

**代码位置**: `packages/backend/src/ws/ws-handler.ts`（新文件）

**职责**：每条 WS 连接的主循环 —— `on('message') → JSON.parse → isWsUpstream → 路由`。

**接口契约**：

```typescript
import type { SubscriptionManager } from './subscription-manager.js';
import type { GapReplayDeps } from './gap-replayer.js';
import type { DriverRegistry } from '../agent-driver/registry.js';
import type { CommRegistry } from '../comm/registry.js';

export interface WsHandlerDeps {
  subscriptionManager: SubscriptionManager;
  driverRegistry: DriverRegistry;
  commRegistry: CommRegistry;
  gapReplayDeps: GapReplayDeps;
}

export interface ConnectionContext {
  connectionId: string;
  userId: string;
  // 后续扩展可加 permissions 等字段
}

export function attachWsHandler(
  ws: WsLike,            // ws-upgrade 挂下来的连接
  ctx: ConnectionContext,
  deps: WsHandlerDeps,
): void;

interface WsLike {
  send(data: string): void;
  on(type: 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
  close(): void;
}
```

**业务逻辑要点**：
1. `subscribe`：调 `subscriptionManager.subscribe(ctx.connectionId, {scope,id})`；若带 `lastMsgId` → 调 `buildGapReplay` 推一条 `gap-replay`；回一条 `ack`。
2. `unsubscribe`：调 `subscriptionManager.unsubscribe(...)`；回 `ack`。
3. `prompt`：从 `driverRegistry.get(instanceId)` 取 driver；若 `driver?.isReady()` 为假 → 回 `error{code:'not_ready'}`；否则 `driver.prompt(text)`，**不** `await`（fire and forget，turn_done 通过事件流自己推回）；立即回 `ack{requestId}`。
  - **subscribe user scope 权限校验**（arch-ws-b 审查新增）：若 `scope==='user'` 且 `id !== ctx.userId` → 回 `error{code:'forbidden'}`，不进 subscription-manager。越权判断不下推给 subscription-manager（保持纯数据结构）。
4. `ping`：回 `pong{ts}`。
5. 异常路径：JSON 解析失败 → `error{code:'bad_request'}`；schema 不合法（`isWsUpstream` 失败）→ `error{code:'bad_request'}`；这些错误**不**断开连接。
6. `close` 事件：调用方（ws-upgrade 那层）负责调 `subscriptionManager.removeConn` + `userSession.unregister`，不在 handler 内重复做。

**预估行数**: 约 180 行。

**完成判据**：
1. 文件 ≤ 200 行。
2. `ws-handler.test.ts`：用 `new EventBus()` 隔离 + 真 SubscriptionManager + 真 DriverRegistry + **假 ws**（用 `EventEmitter` 模拟 send/on，不算 mock 业务）：
   - subscribe 不带 lastMsgId → subscriptionManager 内有记录 + 回 ack
   - subscribe 带 lastMsgId → 先收 gap-replay 再收 ack
   - prompt 到不存在 instance → error{not_ready}（因为 driverRegistry.get 返回 undefined）
   - prompt 到 stub driver (isReady=true) → ack；driver.prompt 被调用 1 次
   - ping → pong
   - bad json → error；连接不断
3. README.md 含时序图：subscribe-with-gap、prompt 两条路径；竞态分析：subscribe 同时到 N 条、prompt 期间断线。

---

### W2-2 · `ws/ws-broadcaster.ts` —— 改造 ws.subscriber，按订阅过滤

**代码位置**: `packages/backend/src/ws/ws-broadcaster.ts`（新文件，替代 `bus/subscribers/ws.subscriber.ts` 的广播职责）

**职责**：subscribe bus.events$ → 对每条事件、对每个 client：
1. `subscriptionManager.match(connectionId, event)` 为 false → drop
2. `visibilityFilter.canSee(connCtx.principal, event)` 为 false → drop
3. 对事件补 `id`（详见 MILESTONE §5.6）→ 序列化 → `ws.send({type:'event', id, event: payload})`

**接口契约**：

```typescript
import type { EventBus } from '../bus/events.js';
import type { SubscriptionManager } from './subscription-manager.js';
import type { VisibilityFilter } from '../filter/visibility-filter.js';
import type { ConnectionContext } from './ws-handler.js';

export class WsBroadcaster {
  constructor(deps: {
    eventBus: EventBus;
    subscriptionManager: SubscriptionManager;
    visibilityFilter: VisibilityFilter;
  });
  addClient(connectionId: string, ws: WsLike, ctx: ConnectionContext): void;
  removeClient(connectionId: string): void;
  start(): void;
  stop(): void;
}
```

**与现有 `bus/subscribers/ws.subscriber.ts` 的关系**：
- 保留旧 `ws.subscriber.ts` 的 `WS_EVENT_TYPES` 白名单（W2-H 守门测试依赖），**但** `start()` 后不再直接广播 —— 改由本模块消费白名单 + 过滤 + 分发。
- 白名单移到 `ws/event-whitelist.ts`（纯 const 文件，< 50 行，作为 W2-2 的同包产物 —— 本条不单列任务）。
- 旧 `ws.subscriber.ts` 改造为"兼容 re-export"：`export { WS_EVENT_TYPES } from '../../ws/event-whitelist.js'`，保持 W2-H 测试可跑；本期最后一个 PR 删除。

**预估行数**: ≤ 200 行（含 event→id 抽取分支）。

**完成判据**：
1. 文件 ≤ 200 行。
2. `ws-broadcaster.test.ts` 用 `new EventBus()` + 真 SubscriptionManager + 真/假 VisibilityFilter：
   - A subscribe team:t1，B subscribe team:t2 → emit `comm.message_sent` teamId=t1 → 只有 A 收到
   - A subscribe global → 收到所有白名单事件
   - A subscribe instance:i1 → 收到 `driver.text` driverId=i1，不收到 driverId=i2
   - 过滤器返回 deny → drop
   - 推送的下行消息里带 `id`（至少对 comm.*, driver.*, team.* 三类事件验证 id 来源）
3. README.md：附事件→id 抽取表、时序图、竞态（subscribe 在途 / event 到达并发）。

---

### A7 · `comm/types.ts` 的 Connection 改 interface（B2 阻断，归属 W2-3）

> **W2-3 owner 第一步做的事**。不改 Connection 类型，SocketShim TS 严格模式一行过不了（`Socket` 是 class，有 100+ 方法/属性）。

**文件**: `packages/backend/src/comm/types.ts:50`

**改动**：

```typescript
// 旧：
// import type { Socket } from 'node:net';
// export type Connection = Socket;

// 新：
/**
 * comm/router 只用到 conn.write / conn.destroyed；把 Connection 收窄到 interface，
 * 让 net.Socket（结构化兼容自然满足）和 ws/user-session.ts 的 SocketShim 都能装入 registry。
 * Why 不用联合类型：少一层 narrow，少一次维护负担。
 */
export interface Connection {
  write(data: string): boolean;
  readonly destroyed: boolean;
  /** 可选：router 主动断开时调用（SocketShim 内部转 ws.close()）。 */
  destroy?(): void;
}
```

**连带改**（grep 查所有 `import { Connection }`）：
- `comm/registry.ts` — 无实质改动（仍存 Connection 实例到 Map）
- `comm/server.ts:29 WeakMap<net.Socket, ConnectionState>` — WeakMap 键类型改 `Connection` 或保留 `net.Socket`（server.ts 只接 TCP，保留更清晰），避免 shim 混进 server.ts 上下文

**依赖**: 无（纯类型改造）。

**预估行数**: 修改 ≤15 行（主要是注释 + 删除 import Socket）。

**完成判据**：
1. `bun tsc --noEmit` 通过，无 narrowing 错
2. `comm/router.ts` 不动；`comm/server.ts` 仍通过（net.Socket 结构化兼容 Connection）
3. W2-3 的 SocketShim 能直接 `: Connection` 实现
4. README 注释说明"Why interface not class"

---

### W2-3 · `ws/user-session.ts` —— WS 连接 ↔ comm.registry

**代码位置**: `packages/backend/src/ws/user-session.ts`（新文件）

**职责**：每条 WS 连接带 userId → 向 `comm.registry` 注册 `user:<userId>`；断开注销。用户发给 `user:u1` 的消息通过现有 comm 路由回本连接。

**接口契约**：

```typescript
import type { CommRegistry } from '../comm/registry.js';
import type { EventBus } from '../bus/events.js';

export interface UserSessionDeps {
  commRegistry: CommRegistry;
  eventBus: EventBus;
}

export class UserSessionTracker {
  constructor(deps: UserSessionDeps);
  /** 传入连接适配：写入 fake socket 让 commRegistry 看起来像 TCP 连接。 */
  register(connectionId: string, userId: string, ws: WsLike): void;
  unregister(connectionId: string): void;
  /** debug 用 */
  listActive(): Array<{ connectionId: string; userId: string }>;
}
```

**实现要点**：
- **前置 A7 已完成**（Connection 改 interface），否则 shim 过不了 TS。
- SocketShim 放 `comm/socket-shims.ts`（<80 行，作为 W2-3 的同包产物）。实现 `Connection` interface：`write(data)` 转 `ws.send(data)` 且 `ws.readyState===OPEN`；`destroyed` getter 读内部 `_dead` 标志；`destroy()` 置位 + `ws.close()`。
- **shim 生命周期**：构造时挂 `ws.addEventListener('close', () => this._dead = true)` 和 `'error'`。任一触发后 `destroyed=true`，router 的 `conn && !conn.destroyed` 分支自动 fallback offline（不需要 shim 主动注销 registry —— 让 unregister 由 ws-upgrade 的 close handler 做，唯一入口）。
- 注册 address 格式：单用户场景默认 `user:local`；多用户时 `user:${userId}`。
- 同一 userId 多 tab：后注册覆盖 + 发 `comm.registered` 事件（旧连接的 shim 在 ws close 后自然 destroyed=true → router 写失败 → offline → 下次上线 tab subscribe 时靠 gap-replay 补，R4-5 覆盖）。
- **heartbeat TODO（不做，README 写明）**：若用户 close tab 浏览器未发 close 事件（移动端熄屏），TCP 超时前 shim 不 destroyed → 消息投给幽灵连接。未来要接 30s 心跳超时自动清理；本期上行已有 `ping`，但**无下行主动 ping**，也**无清理定时器**。arch-ws-b 审查同意本期不做。

**预估行数**: 约 150 行（含 SocketShim）。

**完成判据**：
1. 每文件 ≤ 200 行（含 socket-shims.ts）。
2. `user-session.test.ts`：
   - register 后 `commRegistry.getConnection('user:u1')` 存在
   - unregister 后消失
   - WS send 被调用（用 EventEmitter 假 ws 断言）
   - 多 tab 场景：后注册覆盖前者；前者 shim.destroyed=true
3. README.md：附"为什么 WS 能装进 comm.registry（靠 SocketShim）"、竞态（register/unregister 并发）、错误传播（ws.send 抛 → SocketShim 如何处理）。

---

### W2-4 · `filter/visibility-filter.ts` —— 过滤逻辑

**代码位置**: `packages/backend/src/filter/visibility-filter.ts`（新文件）

**职责**：对给定 principal（"当前连接代表的身份"）+ bus 事件，判断能否看见。

**接口契约**：

```typescript
import type { BusEvent } from '../bus/types.js';
import type { FilterStore, ActorPrincipal, VisibilityDecision } from './types.js';

export interface VisibilityFilter {
  canSee(principal: ActorPrincipal, event: BusEvent): boolean;
  decide(principal: ActorPrincipal, event: BusEvent): VisibilityDecision;
}

export function createVisibilityFilter(store: FilterStore): VisibilityFilter;
```

**算法**（幂等，纯函数）：
1. 抽取事件的 target 集合（comm.* → `[from, to]`；driver.* → `[instanceId]`；team.* → `[teamId]`；其他 → `[]`）。
2. `store.listForPrincipal(principal)` 拿到相关规则；过滤出 target kind 匹配的。
3. 如有 `deny` 规则命中任一 target → `deny`（短路）。
4. 否则若有 `allow` 规则 → `allow`。
5. 都无 → `default_allow`（开放默认；用户未配规则前不影响体验）。

**默认策略扩展点（文件头注释必须写）**：
> 本模块默认 `default_allow`。若未来接多租户/多用户且要求白名单模式，新增一个 `default_policy: 'allow' | 'deny'` 配置入 `filter_configs` 表，由 `createVisibilityFilter(store, opts)` 注入；**不要**硬改本算法。arch-ws-b 审查同意本期保留 default_allow。

**依赖**: `import type` from `./types.js`、`../bus/types.js`；无其他业务 import。

**预估行数**: 约 160 行。

**完成判据**：
1. 文件 ≤ 200 行。
2. `visibility-filter.test.ts` 用真 FilterStore + 真 DB：
   - 无规则 → default_allow
   - deny rule（user u1 → agent i1）+ `comm.message_sent` from i1 to u1 → deny
   - allow rule（user u1 → team t1）+ `team.member_joined` teamId=t1 → allow
   - deny 优先：同时有 allow 和 deny → deny
   - driver.* 按 instanceId 匹配
3. README.md：附"target 抽取表"（每类事件 → target 列表），算法伪码，竞态（规则运行期变更）。

---

### W2-5 · `notification/proxy-router.ts` —— 通知代理模式路由

**代码位置**: `packages/backend/src/notification/proxy-router.ts`（新文件）

**职责**：给定一个"通知事件"，查 `NotificationStore` 配置 → 解析 `to`。纯函数。

**接口契约**：

```typescript
import type { BusEvent } from '../bus/types.js';
import type { NotificationStore, ProxyMode, CustomRule } from './types.js';

export type ProxyTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; instanceId: string }
  | { kind: 'primary_agent' }
  | { kind: 'drop' };

export interface ProxyRouter {
  route(event: BusEvent, userId: string | null): ProxyTarget;
}

export function createProxyRouter(deps: {
  store: NotificationStore;
  /** 注入单例 primaryAgent instanceId；subscriber 从 roster 拿。 */
  getPrimaryAgentInstanceId(): string | null;
}): ProxyRouter;
```

**算法**：
1. 读配置 `store.get(userId)`。
2. `proxy_all` → `{kind:'primary_agent'}`。primary_agent 不在线时 fallback 到 `direct`（记 warn）。
3. `direct` → `{kind:'user', userId: userId ?? 'local'}`。
4. `custom`：遍历 rules，首个 `matchType` 匹配（支持通配）的 rule → 返回 rule.to；全不命中 → `{kind:'drop'}`。

**预估行数**: 约 140 行。

**完成判据**：
1. 文件 ≤ 200 行。
2. `proxy-router.test.ts` 用真 store + 真 DB：3 种 mode × 各 2 个样例 + custom 通配 + fallback 路径 + drop 路径。
3. README.md：含"matchType 通配规则"（`team.*` 匹配 `team.created` 等，但不匹配 `teamx.y`）。

---

### W2-6 · `bus/subscribers/notification.subscriber.ts` —— 订阅通知事件产出通知

**代码位置**: `packages/backend/src/bus/subscribers/notification.subscriber.ts`（新文件）

**职责**：订阅 bus 里的白名单事件（`NOTIFIABLE_EVENT_TYPES`）→ 用 `ProxyRouter.route` 决策 → 走以下之一：
- `to.kind='primary_agent'` → 调 `commRouter.dispatch(envelope)`（from=system, to=primary agent address）
- `to.kind='user'` → emit **新事件** `notification.delivered`（payload 含 target 地址 + 事件本身），由 ws-broadcaster 按订阅推给目标用户 —— **不**过 commRouter（避免落库噪声）
- `to.kind='agent'` → 同 `to.kind='primary_agent'` 但 to 换成指定 instance
- `to.kind='drop'` → 什么都不做

**接口契约**：

```typescript
import type { EventBus } from '../events.js';
import type { ProxyRouter } from '../../notification/proxy-router.js';
import type { CommRouter } from '../../comm/router.js';
import type { Subscription } from 'rxjs';

export interface NotifSubDeps {
  eventBus: EventBus;
  proxyRouter: ProxyRouter;
  commRouter: CommRouter;
  /** 单用户场景传 'local'；多用户需要和 user-session 配合 */
  getActiveUserId(): string | null;
}

export function subscribeNotification(deps: NotifSubDeps): Subscription;
```

**bus 事件扩展**：需要新增 `notification.delivered` 事件类型（触达 TASK §W2-6.1 —— 改 `bus/types.ts` + `bus/subscribers/ws.subscriber.ts` 的白名单）。

- payload（**已按 arch-ws-b 审查去重**）: `{ type:'notification.delivered'; target:{kind:'user'|'agent', id:string}; sourceEventType: string; sourceEventId: string }`
- **不再带 `sourceEventPayload`**。前端按 `sourceEventId` 从本地已缓存事件里找原 payload；避免双推（订 global 的用户会同时收 team.member_joined 本体 + notification.delivered 里的 payload 副本）。
- ws-broadcaster 专门处理：`target.kind='user'` → 只推给订阅 `user:<id>` 的连接；`target.kind='agent'` → 订阅 `instance:<id>` 的连接
- **此事件不进 gap-replay**（通知瞬时，重连补发反而骚扰；与 MILESTONE §5.3 非 comm 不补 gap 一致）

**预估行数**: 约 180 行。

**完成判据**：
1. 文件 ≤ 200 行。
2. `notification.subscriber.test.ts` 用 `new EventBus()` + 真 CommRouter + 真 ProxyRouter + stub primaryAgent instance：
   - `container.crashed` + mode='proxy_all' → commRouter.dispatch 被调（to=primary agent）
   - `team.member_joined` + mode='direct' → bus 上收到 `notification.delivered` 且 target.kind='user'
   - `instance.deleted` + mode='custom' with drop rule → 无任何动作
   - 非白名单事件（如 `driver.text`）不触发 notification
3. README.md：含时序图、竞态（primary_agent 启动中时收到通知）、错误传播（commRouter.dispatch 抛 → subscriber swallow + log）。

---

## 3. 接线改造（零散任务，穿插 W2）

这些是修改现有代码的小改动，不足以单列大任务，统一挂在 W2-1 或 W2-2 的 owner 名下收口：

| # | 文件 | 改动 | 归属 |
|---|------|------|------|
| A1 | `bus/ws-upgrade.ts` | 从 URL query 抽 `userId`（单用户场景 fallback 'local'）；派生 `connectionId = crypto.randomUUID()`；调 `userSession.register` + `attachWsHandler` + `broadcaster.addClient`；`close` 事件 reverse 调用 | W2-3 |
| A2 | `bus/index.ts` → `bootSubscribers` | 注册 `subscribeNotification`；wsBroadcaster 替换为新的 `WsBroadcaster`（deps 注入 subscriptionManager + visibilityFilter） | W2-6 |
| A3 | `http/server.ts` | 构造 SubscriptionManager / UserSessionTracker / FilterStore / NotificationStore / VisibilityFilter / ProxyRouter 单例，喂 bootSubscribers + attachWsUpgrade 的参数 | W2-1（兼 startup 接线） |
| A4 | `db/migrate.ts` | 加载 `visibility_rules.sql` + `notification_configs.sql` + W1-D messages v3 迁移 | W1-D / W1-F / W1-H 各自 PR |
| A5 | `bus/types.ts` + `bus/helpers.ts` | 新增 `notification.delivered` 事件；为所有事件补 `eventId: string`（`makeBase` 用 `crypto.randomUUID()` 生成，强制必填），`comm.*` 里 eventId = messageId；**driver.* 的 id 也 = eventId，不引入 seq counter** | W2-6 |
| A6 | `bus/subscribers/ws.subscriber.ts` | 保留 `WS_EVENT_TYPES` re-export；关闭旧 `WsBroadcaster.start`（让新的接管）| W2-2 |
| A7 | `comm/types.ts` | Connection 从 `Socket` class 改 narrow interface（B2 阻断，详见 W2-3 上方 A7 子章节） | W2-3（owner 第一步） |

---

## 4. 关键约束汇总（checklist）

- [ ] 每个新文件 ≤ 200 行
- [ ] 非业务模块 import 清单不含 `bus/*`、`comm/*`、`notification/*`（彼此之间只允许 `import type`）
- [ ] comm 层零业务 import：`comm/*` 不 import `filter/*` / `notification/*` / `ws/*`
- [ ] 所有下行 WS 消息带 `id`
- [ ] subscribe 支持带 `lastMsgId` 做 gap-replay
- [ ] 测试不 mock db/bus，用真实依赖 + `new EventBus()` 隔离
- [ ] README.md 齐全（每个模块一份）
- [ ] 不碰 `INTERFACE-CONTRACTS.md` 里的冻结接口

---

## 5. 状态表（填表用）

| 任务 | 类型 | Owner | 状态 | 备注 |
|------|------|-------|------|------|
| W1-A protocol.ts | 非业务 | — | 🔲 | |
| W1-B subscription-manager.ts | 非业务 | — | 🔲 | |
| W1-C gap-replayer.ts | 非业务 | — | 🔲 | 依赖 W1-D findUnreadForAddress |
| W1-D messages v3 迁移 + findUnreadForAddress | 非业务 | — | 🔲 | **B1 阻断，优先** |
| W1-E filter/types.ts | 非业务 | — | 🔲 | |
| W1-F filter-store.ts | 非业务 | — | 🔲 | |
| W1-G notification/types.ts | 非业务 | — | 🔲 | |
| W1-H notification-store.ts | 非业务 | — | 🔲 | |
| W2-1 ws-handler.ts (+A3) | 业务 | — | 🔲 | W1-A/B/C 完成后起 |
| W2-2 ws-broadcaster.ts (+A6) | 业务 | — | 🔲 | W1-A/B/E/F 完成后起 |
| W2-3 user-session.ts (+A1 +A7) | 业务 | — | 🔲 | W1-A + A7 接口改造 完成后起 |
| W2-4 visibility-filter.ts | 业务 | — | 🔲 | W1-E/F 完成后起 |
| W2-5 proxy-router.ts | 业务 | — | 🔲 | W1-G/H 完成后起 |
| W2-6 notification.subscriber.ts (+A2/A5) | 业务 | — | 🔲 | W1-G/H + W2-5 + 旧 CommRouter 已存在 |
| W3 回归 | 测试 | — | 🔲 | W2 全部 merge 后起 |

---

## 6. 变更日志

| 日期 | 改动 | 作者 |
|------|------|------|
| 2026-04-25 | 初版 | arch-ws-a |
