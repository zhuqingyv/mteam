# 通知中心设计（Phase 5）— mteam OA 系统通知模块

> **定位**：mteam 的 OA 通知中心。不只是"告知"，而是一个独立模块，统一转发所有通知：
> - **本期**：系统通知（OS 级弹窗，macOS Notification Center / Windows Toast），点击定位到主 Agent 对话窗口
> - **未来**：应用内审批（approve/reject 流，暂不做但模块预留）
>
> **核心原则**：
> - 所有通知都经过这个模块，不允许绕过（类似 OA 系统的统一消息中心）
> - 通知 payload **必须带 title + body**（OS 系统通知必需，不能只给 id 让前端二次查）
> - 每条通知有 `channel` 标识投递目标：`system`（OS 弹窗）/ `in_app`（应用内，未来审批用）/ `both`
> - Electron 主进程收到 WS 推送后调 `new Notification({ title, body })`，`click` 事件聚焦到主 Agent 对话窗口
> - 兼容 macOS + Windows

---

## 1. 现状分析

### 1.1 现有通知系统能做什么

现有 `src/notification/` 模块 + `src/bus/subscribers/notification.subscriber.ts` 的能力边界：

| 功能 | 现状 |
|---|---|
| 代理模式路由（proxy_all/direct/custom） | ✅ 完整（`proxy-router.ts`） |
| 路由配置持久化 | ✅ `notification_configs` 表，DAO `createNotificationStore()` |
| 白名单 | ✅ 9 项 `NOTIFIABLE_EVENT_TYPES`：instance.created/deleted/offline_requested / team.created/disbanded/member_joined/member_left / container.crashed / driver.error |
| 前端收信通道 | ✅ `notification.delivered` 事件在 WS 白名单 (`ws/event-types.ts:50`) |
| 给 Agent 送信 | ✅ 通过 `commRouter.dispatch` 发系统消息 |
| 配置 HTTP 端点 | ❌ 只有 DAO，没挂路由（mnemo #485） |
| **通知历史持久化** | ❌ 完全没有。`notification.delivered` 是纯事件，不入库 |
| **已读 / acknowledge 状态** | ❌ 无 |
| **payload 带 body** | ❌ 只有 `sourceEventType + sourceEventId`，前端必须二次查询 / 本地缓存 |
| **通知类型扩展性** | 受白名单限制：加新类型必须改 `NOTIFIABLE_EVENT_TYPES` + `WS_EVENT_TYPES` 两处 |

### 1.2 `notification.delivered` 现状 payload

`src/bus/types.ts:322`：

```ts
export interface NotificationDeliveredEvent extends BusEventBase {
  type: 'notification.delivered';
  target: { kind: 'user'; id: string } | { kind: 'agent'; id: string };
  sourceEventType: string;
  sourceEventId: string;
  // ❌ 无 body、无 title、无 severity、无 id（只有继承自 base 的 ts/source/correlationId）
}
```

这是 Phase-WS W2-6 的决策：为了**防止订 global 同时收到原事件 + 通知副本导致 UI 双推**，刻意不带 body。前端需要：
1. 订 global 拿到原事件缓存到 store
2. 收到 `notification.delivered` 时根据 `sourceEventId` 去 store 找原事件的详情

**问题**：
- 刷新后前端缓存丢失 → 只收到"有通知发生"的指针，原事件已经错过无法回放 → 通知变成无意义占位符
- 跨标签页 / 多窗口无法共享通知状态
- 主 Agent 收到的通知走的是 `commRouter.dispatch → messageStore`，已经持久化；但**用户通道走的是 ws 事件，未持久化**——路径不对称

### 1.3 proxy-router 三种模式总结

| mode | 用户通道行为 | 主 Agent 通道行为 |
|---|---|---|
| `proxy_all` | 主 Agent 在线 → 用户收不到（被代理）<br>主 Agent 离线 → fallback direct | `commRouter.dispatch` |
| `direct` | `emit notification.delivered` | 无 |
| `custom` | rule.to=user 时走 direct<br>全不命中 drop | rule.to=primary_agent / agent 时 dispatch |

### 1.4 ActionItem 现状

`src/action-item/scheduler.ts`:
- 注入一个 `notify: (to, message) => void` 回调，scheduler 内部调 `notify(assignee, "⏰ 任务...")` 发 reminder。
- 同时 emit `action_item.reminder` / `action_item.timeout` bus 事件（已在 `WS_EVENT_TYPES` 白名单里）。
- 但 `action_item.*` 事件**不在 `NOTIFIABLE_EVENT_TYPES` 里**——这意味着它不走通知系统，只走普通 WS 订阅；没有 acknowledge、没有历史。

---

## 2. 方案：一等公民通知实体 + 持久化 + 已读

### 2.1 核心取舍

把"通知"从**纯事件指针**升级为**DB 一等公民**：

- 引入 `notifications` 表（独立于 `notification_configs`）。
- Bus 上仍然保留 `notification.delivered`，但 **payload 改成带全字段**（`NotificationRecord`），前端一次就能渲染，不再需要二次查询。
- 主 Agent 通道维持现状（走 `commRouter.dispatch`，messages 表已持久化）。

这解决：
1. 刷新不丢（持久化）
2. 前端不用维护"事件 → 通知"的索引映射
3. `NotificationRecord` 独立于 bus 事件结构，通知类型可任意扩展而不污染白名单

### 2.2 通知类型清单

固定枚举 `NotificationKind`：

| kind | 触发源 | severity | 示例 title / body |
|---|---|---|---|
| `quota_limit` | 配额方案里 `QuotaExceededError` 产生时 | warn | "Agent 并发已达上限" / "当前 50/50，需先解散一个团队才能继续" |
| `action_item_reminder` | `action_item.reminder` | info | "任务提醒" / "'修复登录 bug' 还剩 10 分钟" |
| `action_item_timeout` | `action_item.timeout` | warn | "任务超时" / "'修复登录 bug' 已超时" |
| `agent_error` | `driver.error` / `container.crashed` | error | "Agent 异常" / "{memberName} 进程崩溃，退出码 1" |
| `team_lifecycle` | `team.created` / `team.disbanded` / `team.member_joined` / `team.member_left`（可选开关） | info | "团队 X 已创建" 等 |
| `instance_lifecycle` | `instance.created` / `instance.deleted`（可选开关） | info | "{memberName} 已上线" 等 |
| `system` | 兜底（未来新加的系统广播） | info | 自定义 |

> `team_lifecycle` / `instance_lifecycle` 类型对应的原事件**继续走现有白名单**（前端面板无需换通道），只是同时也生成一条 `NotificationRecord` 持久化；是否推给前端通知面板由用户偏好控制（见 §2.7）。

严重等级 `severity: 'info' | 'warn' | 'error'`，用于前端排序 + 图标色。

### 2.3 数据模型

```ts
// src/notification/record.ts
export type NotificationKind =
  | 'quota_limit'           // channel: system（OS 弹窗，紧急）
  | 'action_item_reminder'  // channel: system（快到期了）
  | 'action_item_timeout'   // channel: system（超时了）
  | 'agent_error'           // channel: system（agent 崩了）
  | 'team_lifecycle'        // channel: system（团队创建/解散）
  | 'instance_lifecycle'    // channel: in_app（实例上下线，不弹 OS）
  | 'approval'              // channel: system（未来审批流，本期预留）
  | 'system';               // channel: system（系统级通知）

export type Severity = 'info' | 'warn' | 'error';

export type NotificationChannel = 'system' | 'in_app' | 'both';
// system = OS 级弹窗（macOS Notification Center / Windows Toast），点击定位到主 Agent 对话窗口
// in_app = 应用内通知面板（未来审批流用，本期预留）
// both = 两路都推

export interface NotificationRecord {
  id: string;                  // uuid
  userId: string | null;       // null = 系统默认用户（单用户场景）
  kind: NotificationKind;
  channel: NotificationChannel; // 投递目标
  severity: Severity;
  title: string;               // 一行标题（OS 通知显示，必填）
  body: string;                // 多行详情（OS 通知 body，≤ 1024 字符）
  payload: Record<string, unknown>; // 结构化字段，按 kind 约定
  sourceEventType?: string;    // 关联 bus 事件类型（可选，用于追溯）
  sourceEventId?: string;      // 关联事件 id
  acknowledgedAt: string | null; // 已读时间戳；null=未读
  createdAt: string;
  // 点击行为：Electron 主进程收到 channel=system 的通知后，
  // new Notification({ title, body }) + click → 聚焦到主 Agent 对话窗口
}
```

**payload 约定**（按 kind）：

```ts
// quota_limit
payload: { resource: 'agent'; current: number; limit: number; attemptedBy?: 'primary_agent' | 'leader' }
// action_item_reminder / timeout
payload: { itemId: string; title: string; assigneeId: string; remainingMs?: number }
// agent_error
payload: { instanceId: string; memberName: string; reason: string; exitCode?: number }
// team_lifecycle / instance_lifecycle
payload: { teamId?: string; instanceId?: string; memberName?: string; action: string }
```

### 2.4 Schema

`src/db/schemas/notifications.sql`（新增）：

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id               TEXT PRIMARY KEY,
  user_id          TEXT,                         -- NULL = default user
  kind             TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK(severity IN ('info','warn','error')),
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  payload_json     TEXT NOT NULL,                -- 序列化 payload
  source_event_type TEXT,
  source_event_id  TEXT,
  acknowledged_at  TEXT,                         -- NULL = 未读
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notif_user_unread
  ON notifications(user_id, acknowledged_at) WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notif_created
  ON notifications(created_at DESC);
```

- 未读过滤走部分索引（partial index），单用户场景 O(log n)。
- 历史列表按 `created_at DESC` 分页。

### 2.5 发射点 / 产生侧

新增 `src/notification/notify.ts`：

```ts
export interface NotifyDeps {
  eventBus: EventBus;
  repo: NotificationRepo;   // §2.6
  getActiveUserId: () => string | null;
}

export function createNotifier(deps: NotifyDeps) {
  return {
    push(input: Omit<NotificationRecord, 'id' | 'createdAt' | 'acknowledgedAt' | 'userId'>): NotificationRecord {
      const record = deps.repo.insert({
        ...input,
        userId: deps.getActiveUserId(),
      });
      // bus 上推一份，ws-broadcaster 自然按 WS_EVENT_TYPES 白名单投递。
      deps.eventBus.emit({
        ...makeBase('notification.delivered', 'notification/notify'),
        target: { kind: 'user', id: record.userId ?? 'local' },
        sourceEventType: input.sourceEventType ?? '',
        sourceEventId: input.sourceEventId ?? '',
        record,                         // ← 新增字段，携带全量
      });
      return record;
    },
  };
}
```

**修改 `NotificationDeliveredEvent` 加 `record` 字段**（向后兼容——老前端仍可读 `sourceEventId`）。

**桥接点**（把现有事件/错误翻译成 notification）：

1. `src/domain/role-instance.ts` 抛 `QuotaExceededError`
   → `handleCreateInstance` catch 时调 `notifier.push({ kind:'quota_limit', ... })`
2. `src/action-item/scheduler.ts`：把注入的 `notify(to, message)` 改成 `notifier.push({ kind:'action_item_reminder', ... })`，而不是直接发 commRouter 消息（或者两者都发，见 §2.10）。
3. `src/bus/subscribers/notification-bridge.subscriber.ts`（新增）：订 `driver.error` / `container.crashed` / `action_item.timeout`，翻译成 `notifier.push`。
4. `team.created` / `instance.created` 这类低频+可能高频事件默认**不**生成 notification（可通过 Settings 开关打开）。

### 2.6 存储层 DAO

`src/notification/notification-repo.ts`：

```ts
export interface NotificationRepo {
  insert(input: Omit<NotificationRecord, 'id' | 'createdAt' | 'acknowledgedAt'>): NotificationRecord;
  list(userId: string | null, opts: { unreadOnly?: boolean; limit?: number; cursor?: string }): {
    items: NotificationRecord[];
    nextCursor: string | null;
  };
  get(id: string): NotificationRecord | null;
  acknowledge(id: string, at: string): boolean;        // 单条
  acknowledgeAll(userId: string | null, at: string): number; // 全部已读
  countUnread(userId: string | null): number;
}
```

### 2.7 已读 / acknowledge

- 单条已读：`POST /api/notifications/:id/ack`
- 全部已读：`POST /api/notifications/ack-all`
- 已读动作**也要 emit bus 事件**（`notification.acknowledged`，新增白名单条目），多窗口同步红点计数。
- 未读计数 `GET /api/notifications/unread-count` —— 返回 `{ count: number }`。WS 推 `notification.delivered` 时前端自增；收到 `notification.acknowledged` 时前端自减。

### 2.8 HTTP 端点（新增 `src/http/routes/notifications.routes.ts`）

| method | path | 作用 |
|---|---|---|
| GET | `/api/notifications` | 分页列表（`?unread=1&limit=20&cursor=...`） |
| GET | `/api/notifications/unread-count` | `{ count }` |
| POST | `/api/notifications/:id/ack` | 单条已读 |
| POST | `/api/notifications/ack-all` | 全部已读 |
| GET | `/api/notifications/config` | 代理模式配置（复用 `notification_configs` DAO） |
| PUT | `/api/notifications/config` | 更新代理模式（mnemo #485 的坑也一并补） |

**前端配套**：`/api/panel/notifications/*` 门面转发（按 `panel.routes.ts` 现有 `thin forwarder` 风格加）。

### 2.9 前端对接

WS 推送：
- `notification.delivered`（payload 带 `record` 字段，包含全量）→ 前端 `notificationStore.add(record)` + 触发红点
- `notification.acknowledged`（新）→ 前端移除未读集合里的 id

HTTP 历史：
- 启动时 `GET /api/notifications/unread-count` 初始化红点
- 打开通知面板时 `GET /api/notifications?limit=20` + 滚动翻页用 cursor

组件：
- `NotificationBell`（红点 + 数字）
- `NotificationPanel`（抽屉/下拉）
- `NotificationItem`（按 severity 上色，可点击跳转到相关实体；例如 action_item_reminder 点击跳任务面板）

### 2.10 和 ActionItem 的关系

ActionItem 当前双轨：
- `scheduler.notify(assigneeId, msg)` → commRouter.dispatch → agent 收到系统消息（agent 维度）
- emit `action_item.reminder` → WS 广播（前端维度）

Phase 5 改成三轨：
1. 给 **agent** 保留现有 commRouter 路径（不动）
2. 给**前端**新增一条 `notifier.push({ kind:'action_item_reminder', ... })`（生成 NotificationRecord + emit notification.delivered with record）
3. 原有 `action_item.reminder` bus 事件**保留**，因为前端任务看板可能还用它做实时刷新（两个关注点分开）

这样不动现有 ActionItem 调用方，只加桥接。

### 2.11 主 Agent 收到配额超限的链路

- 主 Agent 调 `create_leader` MCP 工具 → httpJson POST
- Backend 拦到 `QuotaExceededError` → handler 返 409 + 结构化 body
- **同时** handler 调 `notifier.push({ kind:'quota_limit', severity:'warn', ... })`
  - 生成 notification → emit `notification.delivered` → 推给用户前端
- MCP 工具返回给主 Agent 的响应里带 `{ code:'QUOTA_EXCEEDED', current, limit }`
- 主 Agent 读到结构化 error，结合自己的人设决定下一步（给用户发消息、等其他 agent 完成、等等）

**两条路径不冗余**：前端通知面板看见系统级"配额告警"，主 Agent 拿到程序级错误做决策。用户看到的不是"主 Agent 告诉我"这种转述，而是系统直接标红——信息第一手。

### 2.12 proxy-router 怎么配合

`quota_limit` / `action_item_*` / `agent_error` 这类新类型**不走 proxy-router**。原因：
- proxy-router 面向的是"bus 事件"的代理决策，本质是"该不该让主 Agent 先看"
- 新的 NotificationRecord 是"用户视角的系统告知"，目标一直是用户
- 继续保留 proxy-router 处理 9 项旧白名单事件（instance/team/driver.error/container.crashed 的老代理语义）。`driver.error` 如果落到 `agent_error` NotificationRecord，前端也能看到 —— 这是加强，不是替代。

未来若想让某些通知也可代理（例如 "action_item_timeout 默认先给主 Agent 让它汇总"），在 NotificationKind 维度加一条代理规则即可，不用动 proxy-router。

### 2.13 Settings Registry 配置

新增 `src/settings/entries/notification-prefs.ts`（可选、本期最小集）：

```ts
{ key: 'notification.kinds.teamLifecycle.enabled', ... }  // 团队事件是否生成通知（默认 false）
{ key: 'notification.kinds.instanceLifecycle.enabled', ... } // 同上（默认 false）
{ key: 'notification.autoAckDays', schema: {type:'integer',minimum:0}, ... }  // N 天前通知自动已读（默认 0=不自动）
```

`notification.mode`（已有，proxy-router 配置）保留在 `settings/entries/notification.ts`。

---

## 3. 接口契约汇总（给前端）

### 3.1 WS 事件

```ts
// 升级后的 notification.delivered（向后兼容——老前端读 sourceEventId 不受影响）
{
  type: 'notification.delivered',
  ts, source, correlationId,
  target: { kind: 'user', id: string },
  sourceEventType: string,     // 可空字符串
  sourceEventId: string,       // 可空字符串
  record: NotificationRecord   // ← 新增
}

// 新增
{
  type: 'notification.acknowledged',
  ts, source,
  notificationId: string,
  userId: string | null,
  acknowledgedAt: string,
  mode: 'single' | 'all',
}
```

同步更新：
- `src/bus/types.ts` 加 `NotificationAcknowledgedEvent`
- `src/ws/event-types.ts` `WS_EVENT_TYPES` 加 `notification.acknowledged`

### 3.2 HTTP 端点（详细）

```http
GET /api/notifications?unread=1&limit=20&cursor=<base64>
→ 200 { items: NotificationRecord[], nextCursor: string | null }

GET /api/notifications/unread-count
→ 200 { count: number }

POST /api/notifications/:id/ack
→ 204 (成功)  / 404 (不存在) / 409 (已 ack)

POST /api/notifications/ack-all
→ 200 { acknowledged: number }

GET /api/notifications/config
→ 200 NotificationConfig (复用 notification_configs)

PUT /api/notifications/config
Body: { mode, rules? }
→ 200 NotificationConfig
```

---

## 4. 需要修改 / 新增的文件清单

新增：
- `src/db/schemas/notifications.sql`
- `src/notification/record.ts` — NotificationRecord / NotificationKind / Severity 类型
- `src/notification/notification-repo.ts` — DAO
- `src/notification/notification-repo.test.ts`
- `src/notification/notify.ts` — `createNotifier`
- `src/notification/notify.test.ts`
- `src/bus/subscribers/notification-bridge.subscriber.ts` — 把 driver.error / container.crashed / action_item.timeout 桥成 notifier.push
- `src/http/routes/notifications.routes.ts`
- `src/http/routes/notifications.routes.test.ts`
- `src/settings/entries/notification-prefs.ts`（可选）

改动：
- `src/bus/types.ts` — `NotificationDeliveredEvent` 加 `record?`；新增 `NotificationAcknowledgedEvent`
- `src/ws/event-types.ts` — 加 `notification.acknowledged`
- `src/notification/proxy-router.ts` — 不变（保持老语义）
- `src/bus/subscribers/notification.subscriber.ts` — 目标为 user 时 emit 老的指针 + 也要带 record（或改为完全由 notify.ts 接管，原 subscriber 降级为只处理 agent/primary_agent 分发）
- `src/action-item/scheduler.ts`（可选）— 调 notifier.push 做前端通知；agent 路径保留
- `src/api/panel/role-instances.ts::handleCreateInstance` — catch `QuotaExceededError` 时 notifier.push
- `src/http/routes/panel.routes.ts` — forwarder 加 `/api/panel/notifications/*`
- `src/http/server.ts` — 装配 notifier、repo、注入 subscribers

---

## 5. 决策摘要 / 否决的方案

| 决策 | 选择 | 否决方案 |
|---|---|---|
| payload 是否带 body | 带（record 字段） | "保持指针+前端本地缓存" — 刷新丢数据，单用户价值低 |
| 持久化 | 新表 `notifications` | "复用 messages 表" — 语义强耦合，通知不是消息 |
| 提醒机制 | 和 ActionItem scheduler 共存 | "ActionItem 完全换成 notify.push" — agent 路径换掉会破坏现有 MCP 工具集成 |
| ack 是否 emit 事件 | emit `notification.acknowledged` | "只写 DB 不发 bus" — 多窗口 / 多连接不同步 |
| quota_limit 要不要走 proxy-router | 不走 | "复用 proxy_all" — 配额告警必须给用户，不应被主 Agent 代理吞 |
| 通知是否有 TTL / 自动清理 | 开 `autoAckDays` 自动已读（不删除） | "N 天后硬删" — 审计需要，不删只隐藏 |

---

## 6. 验收判据

1. 超配额触发时，前端通知面板 1 秒内出现红点 + 新条目，刷新不丢。
2. `POST /api/notifications/:id/ack` 后红点数立即 -1（WS 推 `notification.acknowledged`），另一标签页同步。
3. `GET /api/notifications?unread=1&limit=20` 翻页 cursor 可用。
4. ActionItem 到 reminder 时间：agent 收到 commRouter 消息（保留），前端收到 `action_item_reminder` NotificationRecord。
5. 主 Agent 在 `system.maxAgents=2` 下第三次 create_leader 返回 `QUOTA_EXCEEDED`，**同时**前端看到一条 `quota_limit` warn 级通知。
6. `NOTIFIABLE_EVENT_TYPES` 旧白名单仍正常工作（instance.created → notification.delivered pointer），不影响现有前端代码路径。
7. 单测：notifier.push 原子落库 + emit；repo.list 分页正确；acknowledge 幂等。

---

## 7. 和方案 1 的交集

- 方案 1 的 `QuotaExceededError` 被方案 2 的 notifier.push 消费，生成 `quota_limit` 通知。
- 两份文档独立落地；方案 1 不依赖方案 2（没有 notifier 也能 return 409），方案 2 不依赖方案 1（就算不限配额，其它通知类型也能工作）。
- 建议实施顺序：方案 2 的 `notifications` 表 + notifier 先落 → 方案 1 上线时把 handler 的 catch 分支接进来。
