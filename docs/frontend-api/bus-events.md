# Bus 事件目录

> **面向**：前端（WS 下行订阅者）。Agent 进程**不连 WS**，收不到这里列的任何事件，只在 stdin 看 `notifyLine`；后端内部 subscriber 也消费 bus 事件但那是实现细节，本文不展开。

WS 下行的 `event.event` 字段里装的就是本目录所列的事件。后端广播前会**剥掉 `source` 和 `correlationId`**，前端看不到。其余字段（`type` / `ts` / `eventId` / 业务字段）完整透传。

## 识别事件

- `event.event.type` 是 discriminator
- `event.event.eventId` = 外层 `event.id`（同一份 UUID）
- `event.event.ts` = ISO8601 时间戳

## 领域分组

### instance.*

| type                            | 关键字段                                                                  |
| ------------------------------- | ------------------------------------------------------------------------- |
| `instance.created`              | `instanceId` `templateName` `memberName` `isLeader` `teamId` `task`       |
| `instance.activated`            | `instanceId` `actor`（可空）                                              |
| `instance.offline_requested`    | `instanceId` `requestedBy` `reason?`（`explicit_deny`/`not_in_whitelist`）|
| `instance.deleted`              | `instanceId` `previousStatus` `force` `teamId` `isLeader`                 |
| `instance.session_registered`   | `instanceId` `claudeSessionId`                                            |

### comm.*

| type                      | 关键字段                                |
| ------------------------- | --------------------------------------- |
| `comm.registered`         | `address`                               |
| `comm.disconnected`       | `address`                               |
| `comm.message_sent`       | `messageId` `from` `to`                 |
| `comm.message_received`   | `messageId` `from` `to` `route`         |

> `comm.*` 的外层 `event.id` 直接等于 `messageId`，便于按消息 id 查找。

### template.* / mcp.*

| type                  | 关键字段        |
| --------------------- | --------------- |
| `template.created`    | `templateName`  |
| `template.updated`    | `templateName`  |
| `template.deleted`    | `templateName`  |
| `mcp.installed`       | `mcpName`       |
| `mcp.uninstalled`     | `mcpName`       |

### team.*

| type                   | 关键字段                                                            |
| ---------------------- | ------------------------------------------------------------------- |
| `team.created`         | `teamId` `name` `leaderInstanceId`                                  |
| `team.disbanded`       | `teamId` `reason`（`manual`/`empty`/`leader_gone`）                 |
| `team.member_joined`   | `teamId` `instanceId` `roleInTeam`                                  |
| `team.member_left`     | `teamId` `instanceId` `reason`（`manual`/`instance_deleted`/`offline_requested`）|

### cli.* / primary_agent.*

| type                           | 关键字段                              |
| ------------------------------ | ------------------------------------- |
| `cli.available`                | `cliName` `path` `version`            |
| `cli.unavailable`              | `cliName`                             |
| `primary_agent.started`        | `agentId` `cliType`                   |
| `primary_agent.stopped`        | `agentId`                             |
| `primary_agent.configured`     | `agentId` `cliType` `name`            |
| `primary_agent.state_changed`  | `agentId` `agentState`（`idle` / `thinking` / `responding`） |

### driver.*

> **面向**：前端（部分）。**注意**：除 `driver.started` / `driver.stopped` / `driver.error`（agent 在线/离线）外，其他 `driver.*`（thinking / text / tool_call / tool_result / turn_done）**已从 WS 白名单移除**，前端请改用 `turn.*` 事件（见 `turn-events.md`）。本表保留是因后端内部订阅者仍在消费。

ACP driver 层流式输出，按 `driverId` 过滤分发。

| type                  | 关键字段                                |
| --------------------- | --------------------------------------- |
| `driver.started`      | `driverId` `pid?`                       |
| `driver.stopped`      | `driverId`                              |
| `driver.error`        | `driverId` `message`                    |
| `driver.thinking`     | `driverId` `content`                    |
| `driver.text`         | `driverId` `content`                    |
| `driver.tool_call`    | `driverId` `name` `input`               |
| `driver.tool_result`  | `driverId`                              |
| `driver.turn_done`    | `driverId`                              |

### worker.*

由 `worker-status.subscriber` 监听 `instance.* / driver.started / driver.stopped / turn.started / turn.completed` 重算全量员工列表、对比快照后增量 emit。前端配合 `get_workers` 首屏快照，完全不需要轮询。详见 [workers-api §实时推送](./workers-api.md)。

| type                     | 关键字段                                         |
| ------------------------ | ------------------------------------------------ |
| `worker.status_changed`  | `name` `status`（`online`/`idle`/`offline`） `instanceCount` `teams`[] |

> `lastActivity` 变化 / 模板元信息（role / persona / avatar / mcps）变化不触发 `worker.status_changed`。模板元信息改动听 `template.updated` / `template.deleted`。

### container.*

| type                  | 关键字段                                                           |
| --------------------- | ------------------------------------------------------------------ |
| `container.started`   | `agentId` `runtimeKind`（`host`/`docker`）`containerId`            |
| `container.exited`    | `agentId` `reason`（`stop_requested`/`max_restart_exceeded`/`normal_exit`） `exitCode` |
| `container.crashed`   | `agentId` `cliType` `exitCode` `signal`                            |

### notification.delivered（特殊）

**只带指针，不带原事件 payload**。前端按 `sourceEventId` 在本地事件缓存里查原事件，避免订 global 时同一事件被重复推两次。

```json
{
  "type": "notification.delivered",
  "target": { "kind": "user", "id": "u_42" },
  "sourceEventType": "driver.turn_done",
  "sourceEventId": "evt_7f8",
  "ts": "2026-04-25T10:00:00Z"
}
```

## 前端 TS Discriminated Union 建议

```ts
type BusEventBase = { type: string; ts: string; eventId?: string };

type InstanceCreated = BusEventBase & {
  type: 'instance.created';
  instanceId: string; templateName: string; memberName: string;
  isLeader: boolean; teamId: string | null; task: string | null;
};
type DriverText = BusEventBase & {
  type: 'driver.text'; driverId: string; content: string;
};
type NotificationDelivered = BusEventBase & {
  type: 'notification.delivered';
  target: { kind: 'user' | 'agent'; id: string };
  sourceEventType: string; sourceEventId: string;
};
// ... 其余 30+ 事件按上表扩

type WsEventInner =
  | InstanceCreated
  | DriverText
  | NotificationDelivered;
  // | ...

// 解包 ws 下行 event 消息
function handle(msg: { type: 'event'; id: string; event: WsEventInner }) {
  switch (msg.event.type) {
    case 'driver.text':          /* msg.event.content 已类型收窄 */ break;
    case 'notification.delivered': /* msg.event.sourceEventId */   break;
  }
}
```

## 注意事项

- **不要依赖 `source` / `correlationId`** —— 已剥离
- **`eventId` 等于外层 `id`** —— 两者取其一即可
- **`notification.delivered` 不含原事件字段** —— 必须自己在前端按 `sourceEventId` 查缓存
- **新增事件**走白名单（backend 的 `WS_EVENT_TYPES`），未列入即使发到 bus 也不下发
