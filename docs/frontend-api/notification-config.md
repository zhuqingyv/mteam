# notification-config

> **面向**：前端 UI（HTTP 读写配置）+ 前端（消费 WS `notification.delivered`）。Agent 不直接配也不直接收，它只在被选为代理目标时以普通消息形式收到通知内容。

**通知系统配置**前端接口。配置决定"用户要不要让 Agent 替他看通知"。

源码：`packages/backend/src/notification/{types,notification-store,proxy-router}.ts`、`packages/backend/src/bus/subscribers/notification.subscriber.ts`。

状态：**HTTP 端点目前仅 DAO 存在，未挂路由**，下面 §4 为建议设计，落地前端时需与后端同步确认。通知投递事件（`notification.delivered`）已在 WS 通道工作，可直接消费。

## 1. 产品场景

| 模式 | 用户视角 | 典型场景 |
|------|----------|----------|
| **全代理** (`proxy_all`) | 所有通知自动交主 Agent 处理，用户不被打扰 | 用户下班 / 让 primary Agent 当"前台" |
| **不代理** (`direct`)    | 每条通知都推到前端，用户自己看 | 默认体验 / 专注盯盘 |
| **自定义** (`custom`)    | 用户配规则：哪些交 Agent，哪些自己看，哪些丢掉 | "团队相关让 Agent 处理，driver 错误我自己看" |

`proxy_all` 下 primary Agent 离线 → 后端自动降级 `direct`（并打 warn 日志），用户不会丢消息。

## 2. 三种模式 TS 类型（前端可直接 copy）

```ts
export type ProxyMode = 'proxy_all' | 'direct' | 'custom';

export type CustomRuleTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; instanceId: string }
  | { kind: 'primary_agent' }
  | { kind: 'drop' };          // 显式丢弃，命中即静默

export interface CustomRule {
  matchType: string;           // bus 事件 type；尾部 '.*' 通配
  to: CustomRuleTarget;
}

export interface NotificationConfig {
  id: string;                  // 单用户场景固定 'default'
  userId: string | null;       // null = 系统缺省
  mode: ProxyMode;
  rules?: CustomRule[];        // 仅 mode='custom' 时有意义，数组顺序即优先级
  updatedAt: string;           // ISO 8601
}
```

字面量**只能**是这三个。旧名 `full_proxy` / `no_proxy` 不要用。

## 3. CustomRule 匹配规则

- `matchType` 以 `.*` 结尾 → **前缀匹配**。`'team.*'` 命中 `team.created` / `team.disbanded` / `team.member_joined` / `team.member_left`。
- 否则**完全相等**。`'driver.error'` 只命中 `driver.error`。
- **不支持**中缀或前缀通配（`'*.created'` 不生效）。
- 规则按数组顺序**自顶向下首命中**返回；全不命中 → `drop`（静默，前端不会收到）。
- `to={kind:'primary_agent'}` 命中时即便 primary 离线也**不降级**，后端订阅层退回给 user，前端仍能收 `notification.delivered`。

## 4. HTTP API 建议端点

### GET `/api/notification/config`

读当前用户的通知配置。无记录时后端即时落库 `{mode:'direct'}` 默认，不会返回空。

**响应**

```json
{
  "id": "default",
  "userId": null,
  "mode": "custom",
  "rules": [
    { "matchType": "team.*",     "to": { "kind": "primary_agent" } },
    { "matchType": "driver.error", "to": { "kind": "user", "userId": "local" } }
  ],
  "updatedAt": "2026-04-25T03:12:55.921Z"
}
```

### PUT `/api/notification/config`

全量覆盖写。后端做类型守卫（`isNotificationConfig`），非法载荷返回 400。

**请求体**

```json
{
  "mode": "proxy_all"
}
```

```json
{
  "mode": "custom",
  "rules": [
    { "matchType": "container.crashed", "to": { "kind": "drop" } },
    { "matchType": "instance.*",        "to": { "kind": "primary_agent" } }
  ]
}
```

**约定**：
- `id` / `userId` / `updatedAt` 由后端填，前端不传。
- `mode !== 'custom'` 时 `rules` 即便传了也会被忽略（DAO 落库时清空 `rules_json`）。
- 切换模式立刻对后续事件生效，不缓存。

## 5. `notification.delivered` WS 事件

当路由到 `kind:'user'` 时，后端不重推原事件，而是 emit 一条**指针事件**走 `/ws/events`：

```json
{
  "type": "notification.delivered",
  "ts": "2026-04-25T03:12:55.921Z",
  "target": { "kind": "user", "id": "local" },
  "sourceEventType": "team.member_joined",
  "sourceEventId": "team.member_joined@2026-04-25T03:12:55.900Z"
}
```

**前端处理**：
- 按 `sourceEventId` 在本地事件缓存找原事件渲染通知卡片，**不要重复渲染**（原事件已通过 global 订阅进来过一次）。
- `notification.delivered` **不进 messages 表**，断线 gap-replay 不补；断线期间丢的通知通过原事件重放恢复。
- 用 `sourceEventType` 决定通知图标 / 模板。

`sourceEventId` fallback 规则详见 `notification-and-visibility.md` §4。

## 6. NOTIFIABLE_EVENT_TYPES 白名单

只有以下 9 种事件会走通知系统；其他事件只通过普通 WS 订阅：

```
instance.created             team.created             container.crashed
instance.deleted             team.disbanded           driver.error
instance.offline_requested   team.member_joined
                             team.member_left
```

写 `CustomRule.matchType` 时只在这 9 种里挑；写别的类型不会报错但永远不会命中。新增可通知事件需后端同步改 `notification/types.ts` 的 `NOTIFIABLE_EVENT_TYPES`。
