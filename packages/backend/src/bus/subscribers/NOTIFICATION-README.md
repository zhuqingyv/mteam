# notification.subscriber.ts — 通知路由胶水（W2-6）

> 业务胶水模块。串接 `notification/proxy-router` 的路由决策 + `comm/router`
> 的消息投递 + `bus` 的事件再发射。契约见 `packages/backend/docs/phase-ws/TASK-LIST.md §W2-6`。

## 这个模块是什么

订阅 bus 事件流，对命中 `NOTIFIABLE_EVENT_TYPES` 白名单的事件：

1. 调 `proxyRouter.route(event, userId)` 拿 `ProxyTarget`
2. `kind='primary_agent' | 'agent'` → 构造 system→agent 的 envelope，交
   `commRouter.dispatch`
3. `kind='user'` → 发射 `notification.delivered` 事件（由 ws-broadcaster 推给
   对应 user 连接）
4. `kind='drop'` → 静默

## 接口

```typescript
import { subscribeNotification } from './notification.subscriber.js';

subscribeNotification(
  {
    proxyRouter,           // 由 A3 在 http/server.ts 注入
    commRouter,            // 同上
    getActiveUserId,       // 单用户场景 () => 'local'
    getPrimaryAgentInstanceId, // 与 proxyRouter 共用；primary 缺席返回 null
  },
  eventBus,                // 默认 defaultBus；测试注入 new EventBus()
);
```

## 时序图

### 场景 A · `direct` 模式 / `team.member_joined`

```
bus                 notification.subscriber          proxyRouter           bus (out)
 │ emit team.member_joined   │                             │                 │
 │──────────────────────────►│                             │                 │
 │                           │ isNotifiableEventType? ✓    │                 │
 │                           │ route(event, userId='local')│                 │
 │                           │────────────────────────────►│                 │
 │                           │◄────────────{user:'local'}──│                 │
 │                           │ emit notification.delivered │                 │
 │                           │                             │ ──────────────► │
 │                           │                                               │
 │                                                                  ws-broadcaster
 │                                                                  按 user:local 订阅推送
```

### 场景 B · `proxy_all` 模式 / `container.crashed`

```
bus                 notification.subscriber          proxyRouter           commRouter
 │ emit container.crashed    │                             │                   │
 │──────────────────────────►│                             │                   │
 │                           │ route(event, userId)        │                   │
 │                           │────────────────────────────►│                   │
 │                           │◄───────────{primary_agent}──│                   │
 │                           │ getPrimaryAgentInstanceId() │                   │
 │                           │        →'inst_leader'       │                   │
 │                           │ buildEnvelope(system→local:inst_leader)         │
 │                           │ dispatch(env) ─────────────────────────────────►│
 │                           │                                   (落库 + 路由)
```

### 场景 C · `custom` 全不命中 / `drop`

```
bus          subscriber     proxyRouter
 │ emit X     │ ─── route(X, uid) ──────────────►│
 │            │◄──────────────────── {drop}──────│
 │            │  return（无任何动作）             │
```

## 竞态分析

| 场景 | 风险 | 解法 |
|------|------|------|
| primary agent 启动中（roster 已写但 driver 未 ready），此时收到 notifiable 事件 | `getPrimaryAgentInstanceId()` 返回 id，但 `commRouter.dispatch` 到 agent 后 driver 回 `not-ready` → envelope 已落库但 agent 不会读到 | CommRouter 的 local-offline 分支会落库，driver ready 后 `router.replay(address)` 自动补推。与在线路径一致 |
| `proxyRouter.store.get(userId)` 与后台面板 `store.upsert` 并发 | 读到旧/新配置 | 每事件查一次配置是 by-design；SQLite 行级原子读写，语义最多"上一个事件按旧配置，下一个事件按新配置"，无中间态 |
| subscriber handler 抛错 | bus 继续分发其它 subscriber 但本条事件丢 | handler try/catch，stderr 记一行，不让错冒回 bus.emit |
| 双 subscriber 并发读同一事件（本 subscriber + ws 旧 broadcaster） | 老 WsBroadcaster 也会把 `notification.delivered` 广播出去（白名单含它） | 这是期望行为：W2-2 新 ws-broadcaster 落地后按订阅过滤；本期过渡用老广播，前端暂时全收 |
| `direct` fallback（proxy_all 下 primary 缺席）和 `custom.primary_agent` fallback | 两路都要回退到 user | proxy-router 负责 `proxy_all` fallback；本文件负责 `custom.primary_agent` fallback。测试各一条覆盖 |

## 错误传播

```
proxyRouter.route 抛
    │
    ▼
subscriber try/catch
    │
    ├── 吞错 + stderr log "[bus/notification] handler failed ..."
    ▼
bus 其它订阅者继续正常收该事件（envelope 未构造，没有脏状态残留）
```

```
commRouter.dispatch rejected
    │
    ▼
void Promise.resolve(...).catch → stderr log
    │
    ▼
事件层面"视作已路由"；重投责任在 commRouter 的 offline/replay，而不是
subscriber 反复重试（避免引入 at-least-once 导致 agent 侧消息重复）
```

## 不变量

1. **非白名单事件不触发任何副作用** —— `isNotifiableEventType` 为唯一入口。
2. **`notification.delivered` 不递归** —— 白名单本身不含该类型 + subscriber 显式
   `if (event.type === 'notification.delivered') return` 双保险，防止未来白名单
   漂移。
3. **subscriber 不直接访问 store** —— 所有配置读取走 `proxyRouter`，保证本文件
   零业务 import（除 envelope-builder 这种纯函数）。
4. **envelope 构造固定 `kind='system'` / `from='local:system'`** —— 防止 agent
   误把通知当普通聊天消息回复。

## 使用示例

```typescript
// http/server.ts 启动链（A3 接线示意）
const notifStore = createNotificationStore(getDb());
const proxyRouter = createProxyRouter({
  store: notifStore,
  getPrimaryAgentInstanceId: () => primaryAgentManager.currentInstanceId(),
});
bootSubscribers(
  { commRouter, proxyRouter, getActiveUserId: () => 'local',
    getPrimaryAgentInstanceId: () => primaryAgentManager.currentInstanceId() },
  config,
);
```

（A2 的 `bootSubscribers` 签名扩展由后续接线任务完成；当前 subscriber 可独立注入。）

## 注意事项 / 边界行为

- **非 gap-replay**：`notification.delivered` 不进 messages 表，断线重连不会补
  推。通知瞬时，错过就错过，不骚扰用户。与 MILESTONE §5.3 "非 comm 不补 gap"
  一致。
- **sourceEventId**：本期用 `messageId | correlationId | type@ts` 组合兜底；A5
  落地后换成统一 `eventId`。前端按该字段在本地缓存里找原事件做"通知→正文"
  关联，而不是从通知 payload 解包副本。
- **用户粒度**：当前单用户 fallback `'local'`；多用户接入时由 user-session /
  ws-upgrade 注入 `getActiveUserId`。本模块不感知具体来源。
- **kind='agent' vs 'primary_agent'**：都走同一 dispatch 代码路径，区别仅在
  `instanceId` 来源（custom rule 字段 vs `getPrimaryAgentInstanceId()`）。

## 测试

- 文件：`notification.subscriber.test.ts`（10 cases）
- 运行：`cd packages/backend && bun test src/bus/subscribers/notification.subscriber.test.ts`
- 覆盖：
  - proxy_all 在线 → dispatch primary
  - proxy_all 离线 → fallback direct
  - direct × (默认 / 指定 userId)
  - custom × (drop / agent / primary_agent 缺席回退)
  - 非白名单事件静默
  - 自循环守门
  - handler 抛错不阻塞 bus

## 行数 / 依赖体检

- `notification.subscriber.ts` < 200 行（`wc -l` 验证）。
- 运行时 import：`rxjs` / `../events.js` / `../helpers.js` / `../../notification/types.js`
  / `../../comm/envelope-builder.js`；其余 `import type`。
- 不 import `notification/notification-store.js`（store 由 proxy-router 内部
  持有，subscriber 不反向依赖 DAO）。
- 符合 REGRESSION R6-1 / R6-3（胶水允许运行时 import bus / comm / notification）。
