# 通知中心 API

> **面向**：前端（Electron renderer / Web 客户端）消费 `notification.delivered` WS 事件的一方。
>
> **与 `notification-and-visibility.md` 的区别**：
> - `notification-and-visibility.md` 讲**路由代理层**（proxy-router 怎么把事件分发到 user / agent / primary_agent，只带 `target + sourceEventType + sourceEventId` 三件套的"通知指针"）。
> - 本文件讲**通知中心层（Phase 5 新增）**：业务代码显式落库 `notifications` 表 + emit 一条带 `title / body / channel / severity / kind / payload` 的富事件，用于触发**OS 系统通知**。
> - 两条路径**并存**，前端按事件里到底带了哪些字段来判定来源。

源码：`packages/backend/src/notification-center/{types,repo}.ts` · `packages/backend/src/bus/types.ts` `NotificationDeliveredEvent` · 用例参考 `packages/backend/src/api/panel/role-instances.ts` `emitQuotaLimitNotification`。

## 1. TS 类型

### 1.1 NotificationRecord

持久化通知实体，落 `notifications` 表。

```ts
type NotificationKind =
  | 'quota_limit'            // 配额超限（本期仅 agent 创建路径触发）
  | 'action_item_reminder'   // 待办临近到期提醒
  | 'action_item_timeout'    // 待办超时
  | 'agent_error'            // driver.error
  | 'team_lifecycle'         // team.created / disbanded / member_*
  | 'instance_lifecycle'     // instance.created / deleted / offline_requested
  | 'approval'               // 审批 action_item
  | 'system';                // 兜底/系统级

type NotificationChannel = 'system' | 'in_app' | 'both';
// system = 仅 OS 弹窗；in_app = 仅应用内通知中心；both = 两处都显示

type Severity = 'info' | 'warn' | 'error';

interface NotificationRecord {
  id: string;                           // UUID，前端 ack 时用这个
  userId: string | null;                // 单用户固定 'local'；null 表示"默认用户"
  kind: NotificationKind;
  channel: NotificationChannel;
  severity: Severity;
  title: string;                        // OS 通知标题
  body: string;                         // OS 通知正文
  payload: Record<string, unknown>;     // 结构化辅助字段（如 quota_limit 的 { resource, current, limit }）
  sourceEventType?: string;             // 可选：原 bus 事件 type（路由层路径会有，notification-center 落库一般不带）
  sourceEventId?: string;               // 可选：原 bus 事件 id / messageId / correlationId
  acknowledgedAt: string | null;        // ISO；null = 未读
  createdAt: string;                    // ISO
}
```

### 1.2 NotificationDeliveredEvent（WS 下行）

WS `event.event` 载荷。字段全部**可选**，因为两条来源路径填的字段不同：

```ts
interface NotificationDeliveredEvent {
  type: 'notification.delivered';
  ts: string;
  eventId?: string;

  // ---- 路由代理层（notification-and-visibility §4）----
  target?: { kind: 'user'; id: string } | { kind: 'agent'; id: string };
  sourceEventType?: string;
  sourceEventId?: string;

  // ---- 通知中心层（Phase 5 新增，OS 通知用）----
  notificationId?: string;              // NotificationRecord.id，前端 ack 用
  channel?: NotificationChannel;        // 决定是否弹 OS 通知（见 §2）
  severity?: Severity;
  kind?: NotificationKind;
  title?: string;                       // OS 通知标题，缺省用 sourceEventType 退化
  body?: string;                        // OS 通知正文
  payload?: Record<string, unknown>;    // 结构化渲染字段
}
```

> 后端 `BusEventBase` 的 `source` 和 `correlationId` 在 WS 广播前已被剥离，前端 WS 端看不到。

## 2. Electron OS 通知触发规则

```
if (event.type === 'notification.delivered' && event.channel && event.title) {
  if (event.channel === 'system' || event.channel === 'both') {
    // 触发 Electron Notification（或 Web Notification API）
    new Notification(event.title, {
      body: event.body ?? '',
      // severity → icon/sound 映射自行实现
    });
  }
  if (event.channel === 'in_app' || event.channel === 'both') {
    // 追加到应用内通知中心抽屉
  }
}
```

**判定是哪条路径**：
- 带 `channel + title` → 通知中心路径（Phase 5），按上面规则弹 OS 通知。
- 只带 `target + sourceEventType + sourceEventId` 没有 `channel` → 路由代理路径（`notification-and-visibility.md §4`），用 `sourceEventId` 去本地缓存查原事件渲染，**不要**弹 OS 通知。

**severity → 视觉映射建议**（前端可自定）：
| severity | 图标/颜色 | OS 通知 sound |
|---|---|---|
| `info`  | 蓝色信息 | 默认 |
| `warn`  | 黄色感叹 | warn 音 |
| `error` | 红色错号 | error 音 |

## 3. 典型事件示例

### 3.1 配额超限（`quota_limit`，severity=warn，channel=system）

触发路径：用户面板创建 agent 命中配额上限 → `POST /api/panel/instances` 返回 `409`，**同时**后端落库 1 条 notification + emit `notification.delivered`。

```json
{
  "type": "notification.delivered",
  "ts": "2026-04-27T03:12:55.921Z",
  "target": { "kind": "user", "id": "local" },
  "notificationId": "e1fc...uuid",
  "kind": "quota_limit",
  "channel": "system",
  "severity": "warn",
  "title": "Agent 创建失败",
  "body": "已达上限 5/5，无法创建新 agent",
  "payload": { "resource": "agent", "current": 5, "limit": 5 }
}
```

> 本期**不**暴露 `GET /api/notifications` 列表接口和 `POST /api/notifications/:id/ack` 端点 —— DAO (`findById` / `listByUser` / `acknowledge` / `acknowledgeAll`) 已实现但未挂 HTTP。前端如果要做"未读计数 + 列表 + 标记已读"的应用内通知抽屉，先和后端对齐端点形状再实现调用。

## 4. 前端订阅与去重

- 订阅 `user:<userId>` 或 `global` 都能收到 `notification.delivered`。
- 同一次业务动作可能**同时**触发"原事件"（如 `instance.created`）和"通知副本"。前端按 **`notificationId`**（通知中心路径）或 **`sourceEventId`**（路由代理路径）去重，**不要**重复弹 OS 通知。
- 触发 OS 通知的前提是浏览器/Electron 已获得 `Notification.permission === 'granted'`。权限未授予时只做应用内显示。
- `notification.delivered` **不走 gap-replay 补发**。断线期间丢的通知可通过原事件重放或（未来开放的）HTTP 列表端点恢复。

## 5. 已知限制 / TODO

- **HTTP 未挂载**：列表、未读计数、ack、ackAll 全无 HTTP 端点。前端按需跟后端开。
- **`sourceEventType` / `sourceEventId` 在通知中心路径可选**：目前 `emitQuotaLimitNotification` 不带（id:853 决策）；其他业务入口按需补。
- **`channel=in_app` 仅约定**：后端只负责落库 + emit；前端自己决定渲染抽屉；没有"OS 静默"的额外字段。
