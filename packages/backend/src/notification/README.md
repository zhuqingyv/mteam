# notification/ — 通知类型契约 + 代理模式 DAO

> 本目录两份模块：
> - `types.ts`（W1-G 交付）：纯类型 + 类型守卫 + `matchRule`。
> - `notification-store.ts`（W1-H 交付）：`notification_configs` 表 DAO。
>
> 纯类型模块。不 import 任何业务代码（bus / db / comm / config）。
> 业务侧 `bus/subscribers/notification.subscriber.ts` 消费这些类型，不反向依赖。

## 这个模块是什么

通知系统的类型契约：三种代理模式、custom 自定义规则、可通知事件白名单、运行期类型守卫。

## 接口定义

```typescript
export type ProxyMode = 'proxy_all' | 'direct' | 'custom';

export type CustomRuleTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; instanceId: string }
  | { kind: 'primary_agent' }
  | { kind: 'drop' };

export interface CustomRule {
  matchType: string;          // 支持尾部 '.*' 通配
  to: CustomRuleTarget;
}

export interface NotificationConfig {
  id: string;                 // 单用户场景固定 'default'
  userId: string | null;      // null = 系统缺省
  mode: ProxyMode;
  rules?: CustomRule[];       // 仅 custom 用
  updatedAt: string;
}

export const NOTIFIABLE_EVENT_TYPES: ReadonlySet<string>; // 9 项白名单

export interface NotificationStore {
  get(userId: string | null): NotificationConfig;
  upsert(cfg: NotificationConfig): void;
}

// 类型守卫
export function isProxyMode(v: unknown): v is ProxyMode;
export function isNotifiableEventType(t: string): boolean;
export function isCustomRuleTarget(v: unknown): v is CustomRuleTarget;
export function isCustomRule(v: unknown): v is CustomRule;
export function isNotificationConfig(v: unknown): v is NotificationConfig;
export function matchRule(rule: CustomRule, eventType: string): boolean;
```

## 三种 mode 语义

| mode        | 路由行为                                                                     |
|-------------|-----------------------------------------------------------------------------|
| `proxy_all` | 白名单内的事件一律 dispatch 给 primary agent；primary 不在线 → fallback `direct`。 |
| `direct`    | 白名单事件直接推给配置归属的 user 连接。                                       |
| `custom`    | 按 `rules` **自顶向下** 首命中；全不命中 → **drop**（静默）。                   |

> 非白名单事件（`NOTIFIABLE_EVENT_TYPES` 以外）完全不进通知系统，只经普通 WS 订阅路径推送。

## custom 规则匹配算法

1. 当 bus 触发事件 `E`，先判断 `isNotifiableEventType(E.type)`；不通过直接放行（普通订阅路径）。
2. 取当前 user 的 `NotificationConfig`。若 mode ≠ 'custom'，按该 mode 语义处理。
3. mode = 'custom' 时，遍历 `rules` 数组：
   - 对每条 rule 调 `matchRule(rule, E.type)`。
   - **首个返回 true 的 rule 即命中**，根据其 `to.kind` 路由；后续 rule 不再评估。
4. 全部 rule 未命中 → drop（不发通知）。

### 通配语法

- `matchType: 'team.*'` 命中以 `team.` 开头的任意事件（如 `team.created`、`team.member_joined`）。
- `matchType: 'team.created'` 完全相等匹配。
- **仅支持尾部 `.*`**；前缀 / 中缀通配按字面处理，不会误命中。

### 目标 kind 语义

| kind            | 路由动作                                                   |
|-----------------|-----------------------------------------------------------|
| `user`          | 推 `notification.delivered` 给 `user:<userId>` 连接。       |
| `agent`         | `commRouter.dispatch` 给 `agent:<instanceId>`。             |
| `primary_agent` | `commRouter.dispatch` 给当前 primary agent；离线 fallback direct。 |
| `drop`          | 显式忽略，不发送。                                          |

## 使用示例

```typescript
import { isProxyMode, matchRule, NOTIFIABLE_EVENT_TYPES } from './types.js';

if (!NOTIFIABLE_EVENT_TYPES.has(event.type)) return;      // 非白名单直接跳

const cfg = store.get(userId);
if (cfg.mode === 'custom') {
  for (const rule of cfg.rules ?? []) {
    if (matchRule(rule, event.type)) {
      return dispatch(rule.to, event);
    }
  }
  return; // 全不命中 → drop
}
```

## 注意事项 / 边界行为

- **不持久化**：本文件只给类型；持久化由 W1-H `notification-store.ts` + `notification_configs` 表负责。
- **白名单与 bus/types.ts 耦合**：9 项事件字面量必须和 `BusEventType` 对齐；新增通知化事件时两边一起改，`types.test.ts` 会锁 size。
- **`default` 的 mode 约定**：spec 缺省推荐 `proxy_all`，但本文件不强制；由 `NotificationStore.get()` 实现层保证。
- **rules 顺序敏感**：自顶向下首命中；把更具体的 rule 放前面，`drop` 兜底放最后。
- **守卫对 `rules` 全量校验**：对于大规则集有 O(n) 成本，DAO 层反序列化时只跑一次，不要放热路径。

## 测试

- 文件：`notification/types.test.ts`
- 覆盖：ProxyMode 字面量、白名单 size=9、`CustomRuleTarget`/`CustomRule`/`NotificationConfig` 守卫各分支、`matchRule` 通配与边界。
- 运行：`cd packages/backend && bun test src/notification/types.test.ts`

## 行数 / 依赖体检

- `types.ts` 102 行（上限 200）。
- import 清单：空。不 import `bus/*`、`db/*`、`comm/*`、`http/*` 或任何同项目业务代码。
- 符合 REGRESSION R6-1（≤200 行）、R6-3（非业务零业务 import）。

---

# notification/notification-store.ts — 通知配置 DAO（W1-H 交付）

## 这个模块是什么

`notification_configs` 表的读写 DAO。给 `notification.subscriber`（W2-6 胶水）一个
单一入口，按 `userId` 拿当前代理模式和 custom 规则。

单文件 ≤ 200 行；只依赖 `../db/connection.js` 与 `./types.js`；不 import
`bus/*` `comm/*` `ws/*`（源码 grep 守门见测试 §"非业务 import 守门"）。

## 接口

```typescript
import type { Database } from 'bun:sqlite';
import type { NotificationStore } from './types.js';
import { createNotificationStore } from './notification-store.js';

export function createNotificationStore(db?: Database): NotificationStore;
```

`db` 参数可注入（单测便利）；缺省走 `getDb()` 单例。返回值实现 W1-G 的
`NotificationStore { get, upsert }`。

## 使用示例

```typescript
const store = createNotificationStore();

// 订阅层每次消费 notifiable 事件前读当前配置
const cfg = store.get(userId /* null = 系统 default */);
switch (cfg.mode) {
  case 'proxy_all': return dispatchPrimary(event);
  case 'direct':    return pushToUser(event);
  case 'custom':    return routeCustom(cfg.rules ?? [], event);
}

// 面板改配置
store.upsert({
  id: 'default',
  userId: null,
  mode: 'custom',
  rules: [
    { matchType: 'team.*',            to: { kind: 'user', userId: 'local' } },
    { matchType: 'container.crashed', to: { kind: 'primary_agent' } },
    { matchType: 'driver.error',      to: { kind: 'drop' } },
  ],
  updatedAt: new Date().toISOString(),
});
```

## Schema

位于 `packages/backend/src/db/schemas/notification_configs.sql`，由
`db/connection.ts::applySchemas` 启动时一并建表：

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

## 默认配置语义（store 内部 ensure）

`get()` 未命中时**就地**落一条 `{mode:'direct'}` 并返回；调用方不需要自行插入。
理由：订阅层每事件都会查一次，"无结果 → 临时对象 → fallback" 的旁路分支是纯噪音；
DAO 内做一次写后续纯读路径更干净。

选择 `direct` 而非 W1-G README 提到的 spec 缺省 `proxy_all` 的理由（TASK-LIST
§W1-H 完成判据 §3 明文）：未配置 primary agent 的场景也能工作；proxy_all 在
primary 缺席时还要 fallback，起点选 direct 少一层链路。

## 回退策略（脏数据容错）

| 场景 | DAO 行为 |
|------|---------|
| `rules_json` JSON.parse 抛错 | 整条配置退 `direct`（rules 丢弃） |
| `rules_json` 不是数组 | 同上 |
| `rules_json` 数组含非法元素（`isCustomRule=false`） | 整体视作脏数据，退 `direct` |
| 库里 `mode` 脏（绕过 CHECK） | 退 `direct` |

原则：DAO **不抛错**。通知系统退化为 direct 可用状态，而不是让整条事件消费链炸掉。
脏数据靠 schema CHECK（第一道）+ DAO 回退（第二道）双保险。

## 持久化（R3-7 覆盖）

`upsert → closeDb → 重开 → get` 读回同一份配置。测试里通过切 `TEAM_HUB_V2_DB`
到临时文件路径真实验证（不是 :memory:）。

## 注意事项

1. `get(null)` 和 `get('u1')` 各自落独立行（`id='default'` vs `id='u1'`），
   多用户场景互不串扰；`user_id` UNIQUE 索引兜底。
2. `user_id` 列是 UNIQUE，但 SQLite 把多个 NULL 视为不同；`id` 是 PK 保底，
   `get(null)` 始终用 `id='default'` upsert，不会重复插行。
3. 非 custom 模式下 upsert 若携带 `rules`，`rules_json` 落 NULL；避免 rules
   跟着模式切换留下僵尸数据。
4. `bun:sqlite` 不支持 `.pragma(...)` 快捷方法；本 DAO 不触发 PRAGMA，连接
   层已处理。

## 测试

- 文件：`notification-store.test.ts`（13 cases，33 expect）
- 运行：`cd packages/backend && bun test src/notification/notification-store.test.ts`
- 覆盖：
  - default ensure × 3（null / userId / 幂等）
  - upsert 往返 × 4（custom 回写、proxy_all→custom 覆盖、非 custom 丢 rules、R3-7 文件持久化）
  - 脏数据回退 × 4（坏 JSON、非数组、非法 rule、schema CHECK）
  - 多用户隔离 × 1
  - 非业务 import 守门 × 1（grep `bus/|comm/|ws/` 零匹配）

## 行数 / 依赖体检

- `notification-store.ts` 108 行（上限 200）。
- import 清单：`bun:sqlite` 类型、`../db/connection.js::getDb`、`./types.js`。
  不 import `bus/*`、`comm/*`、`ws/*` 或任何业务代码。
- 符合 REGRESSION R6-1（≤200 行）、R6-3（非业务零业务 import）。

---

# notification/proxy-router.ts — 通知代理模式路由（W2-5 交付）

## 这个模块是什么

纯函数路由器。给定一个已属于 `NOTIFIABLE_EVENT_TYPES` 的 bus 事件 + 当前 userId，
按 `NotificationStore` 配置解析成一个 `ProxyTarget`（发给谁 / drop）。

- **业务胶水层**：读配置 + 看 runtime 的 primary agent 在线状态，但不自己订阅 bus、
  不自己调 commRouter。真正的分发由 W2-6 `notification.subscriber` 承担。
- 不做白名单校验（`isNotifiableEventType`）；调用方必须先守门。

## 接口

```typescript
import type { BusEvent } from '../bus/types.js';
import type { NotificationStore } from './types.js';

export type ProxyTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; instanceId: string }
  | { kind: 'primary_agent' }
  | { kind: 'drop' };

export interface ProxyRouter {
  route(event: BusEvent, userId: string | null): ProxyTarget;
}

export interface ProxyRouterDeps {
  store: NotificationStore;
  getPrimaryAgentInstanceId(): string | null; // 无 primary → null
  warn?: (msg: string) => void;               // 默认 console.warn
}

export function createProxyRouter(deps: ProxyRouterDeps): ProxyRouter;
```

## 时序图

```
调用方（notification.subscriber）         proxy-router              notification-store   roster/primary
        │                                    │                            │                  │
        │  isNotifiableEventType(e.type)?    │                            │                  │
        │─(true 才往下走；false 直接 return)─│                            │                  │
        │                                    │                            │                  │
        │  route(e, userId)                  │                            │                  │
        ├───────────────────────────────────▶│                            │                  │
        │                                    │  store.get(userId)         │                  │
        │                                    │───────────────────────────▶│                  │
        │                                    │◀──cfg (mode, rules?)───────│                  │
        │                                    │                            │                  │
        │                                    │  if mode=='proxy_all':     │                  │
        │                                    │    getPrimaryAgentInstanceId()                │
        │                                    │────────────────────────────────────────────▶ │
        │                                    │◀──instanceId | null───────────────────────── │
        │                                    │    null → warn + direct fallback             │
        │                                    │                                              │
        │                                    │  if mode=='direct':   → {kind:'user', ...}   │
        │                                    │  if mode=='custom':   遍历 rules 首命中      │
        │                                    │                       全不命中 → {kind:'drop'}│
        │◀──ProxyTarget──────────────────────│                                              │
```

## 三模式决策表

| mode        | cfg 条件            | primary 在线 | 输出 `ProxyTarget`                     | 备注                              |
|-------------|---------------------|-------------|----------------------------------------|-----------------------------------|
| `proxy_all` | —                   | 是          | `{kind:'primary_agent'}`               | 由订阅层走 `commRouter.dispatch`  |
| `proxy_all` | —                   | 否          | `{kind:'user', userId: userId??'local'}` | 降级 direct + `warn` 一行日志   |
| `direct`    | —                   | 任意        | `{kind:'user', userId: userId??'local'}` | 由订阅层 emit `notification.delivered` |
| `custom`    | rules 首命中 `user` | 任意        | `{kind:'user', userId}`                | 规则自带 userId，不看入参         |
| `custom`    | rules 首命中 `agent` | 任意       | `{kind:'agent', instanceId}`           | 订阅层按 `agent:<id>` dispatch    |
| `custom`    | rules 首命中 `primary_agent` | 任意 | `{kind:'primary_agent'}`           | **不** fallback direct（用户显式要代理）|
| `custom`    | rules 首命中 `drop`  | 任意       | `{kind:'drop'}`                        | 显式静默                          |
| `custom`    | 全不命中            | 任意        | `{kind:'drop'}`                        | 等价于兜底 drop                   |

> `primary_agent` kind 的两种触达路径区别：`proxy_all` 有 fallback；`custom` rule 里显式写
> `primary_agent` **不**降级（把决策权交给规则作者，避免"用户明确选了代理却被静默降级"）。

## custom 规则匹配语义

直接复用 `./types.ts::matchRule`：

- `matchType: 'team.*'` 命中 `team.created` / `team.member_joined` 等同前缀族。
- `matchType: 'team.created'` 完全相等。
- 仅尾部 `.*` 通配；`*.created` / `team.*.x` 按字面处理，不误命中。

### 顺序敏感

rules 数组**自顶向下**评估，首个 `matchRule=true` 的 rule 立即返回，后续不再看。
写规则时把更具体的放前、兜底（如显式列出 `container.*` 后跟 drop）放后。

## 使用示例

```typescript
import { createNotificationStore } from './notification-store.js';
import { createProxyRouter } from './proxy-router.js';
import { isNotifiableEventType } from './types.js';

const store = createNotificationStore();
const router = createProxyRouter({
  store,
  getPrimaryAgentInstanceId: () => roster.findPrimaryAgent()?.instanceId ?? null,
});

eventBus.all$.subscribe((event) => {
  if (!isNotifiableEventType(event.type)) return;
  const target = router.route(event, activeUserId);
  switch (target.kind) {
    case 'drop': return;
    case 'primary_agent': return commRouter.dispatch({ to: `agent:${primaryId}`, ... });
    case 'agent':         return commRouter.dispatch({ to: `agent:${target.instanceId}`, ... });
    case 'user':          return eventBus.emit({ type: 'notification.delivered', target, ... });
  }
});
```

## 竞态分析

| 场景 | 风险 | 处理 |
|------|-----|------|
| route 过程中 store 被 upsert | 读到半新半旧的 cfg | `store.get()` 是同步 SQLite 单查询，语句内原子；一次 route 只读一次，不存在"中途切换" |
| route 过程中 primary agent 离线 | 决策基于瞬时状态 | `getPrimaryAgentInstanceId()` 每次 route 内调 1 次；该调用之后状态变化的窗口由 commRouter offline 分支兜 |
| rules 数组被并发替换 | 遍历中指针失效 | `cfg.rules` 是 DAO 新反序列化的引用，和 store 内部状态隔离；upsert 只写 DB |

## 错误传播路径

| 失败点 | 处理 | 最终状态 |
|-------|------|---------|
| `store.get()` 抛错 | 不捕获，向上冒泡 | 订阅层吞掉并 warn（由 W2-6 胶水负责）；本事件丢通知，bus 原事件不受影响 |
| `getPrimaryAgentInstanceId()` 抛错 | 不捕获，向上冒泡 | 同上 |
| `cfg.mode` 非预期值（类型意义上不可能） | TS 三分支穷举，落到 custom 兜底 | 不会走到；若真走到且 `rules=undefined`，遍历空即 drop |
| `rule.to.kind` 未知 | router 不解读 `to`，原样返回 | 调用方 switch 覆盖全 kind（TS 编译保证）|

## 完成判据对照

| 判据 | 证据 |
|------|------|
| 文件 ≤ 200 行 | `proxy-router.ts` 72 行 |
| 真 store + 真 DB + 3 mode × 2 样例 + custom 通配 + fallback + drop | `proxy-router.test.ts` 12 cases / 20 expect 全绿 |
| README 含通配规则说明 | 本节 "custom 规则匹配语义" |
| 业务胶水层 README 必备 | 时序图 ✅ / 三模式决策表 ✅ / 竞态分析 ✅ / 错误传播 ✅ |

## 行数 / 依赖体检

- `proxy-router.ts` 72 行（上限 200）。
- import 清单：`./types.js`（运行时 + 类型）、`../bus/types.js`（**type-only**）。
  无运行时 `bus/*` / `comm/*` / `ws/*` / `db/*` 业务代码 import。
- 测试含 "非业务 import 守门" case：对源文件 regex `import (?!type) ... from '*/(bus|comm|ws|db)/'` 零匹配。
- 符合 REGRESSION R6-1（≤200 行）、R6-3（非业务零业务 import）。
