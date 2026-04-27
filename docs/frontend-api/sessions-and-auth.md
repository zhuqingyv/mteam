# sessions & auth

> **面向**：
> - **§1–§3 + §5（WS `userId` / user-scope 越权）** — 前端（WebSocket 客户端）。
> - **§4（`POST /api/sessions/register`）** — **agent 容器内 bootstrap 脚本**调用，前端不调。

WS 连接身份约定 + Role Instance session 注册接口。本期单用户场景，多用户为后续 phase 预留。

源码：`packages/backend/src/bus/ws-upgrade.ts`、`packages/backend/src/ws/{user-session,ws-handler}.ts`、`packages/backend/src/http/routes/sessions.routes.ts`、`packages/backend/src/api/panel/sessions.ts`。

## 1. WS 连接：`userId` 通过 query 传

WS 端点：`ws://<host>:<port>/ws/events?userId=<userId>`

```ts
// 示例
const ws = new WebSocket(`ws://localhost:8787/ws/events?userId=local`);
```

**规则**：
- `userId` 从 query 取，缺省值 `'local'`（单用户场景默认即可）。
- upgrade 阶段不做认证，**信任客户端传入**（本期单机部署）。多用户接入时改 `ws-upgrade.ts` 增加 token 校验，前端 API 不变。
- 连接建立后，后端把该 WS 注册为 `user:<userId>` 地址挂到 `commRegistry`，这样 agent 侧 `send_msg(to='user:<userId>')` 能直达前端。

**连接生命周期副作用**（后端自动处理，前端无感知）：
- 注册 `user:<userId>` 到 commRegistry
- 注册 connectionId 到 subscriptionManager（前端后续 `subscribe` / `unsubscribe` 基于它）
- 注册 broadcaster client（前端后续接收事件基于它）

## 2. 多 tab 覆盖语义

**同一 `userId` 开多 tab**：后注册的**覆盖**前者。

```
tab A 连接 (userId=local) → commRegistry: user:local = shimA
tab B 连接 (userId=local) → commRegistry: user:local = shimB（shimA 被 destroy）
tab A 收不到新事件；发给 user:local 的消息走 shimB
tab A 关闭时：后端检查 registry 上是否还是自己的 shim，不是则不动（避免误删 B）
```

**断线重连语义**：
- tab A 被覆盖 → shim 标记 `_dead` → router dispatch 走 offline → 消息进 messages 表
- tab A 重连 → subscribe 时带 `lastMsgId` → gap-replay 补推断线期间事件

**前端推论**：
- 想避免互踢，不同 tab 用不同 `userId`（例如 `local-tab1` / `local-tab2`）。但本期前端只有一个 panel，不鼓励。
- **不要**在页面刷新时假设"之前的 tab 还能收到消息" —— 后一次连接建立即覆盖。

## 3. user scope 越权规则

WS 上行 `subscribe` 支持 `scope: 'user'`。**只能订阅自己**：

```ts
// 允许
{ op: 'subscribe', scope: 'user', id: 'local' }  // 连接时 userId=local

// 拒绝（返回 WsError）
{ op: 'subscribe', scope: 'user', id: 'other' }
// → { type: 'error', code: 'forbidden', message: 'cannot subscribe other user' }
```

判定点：`ws-handler.ts:95`，`msg.id !== ctx.userId` 直接回 `forbidden`。其他 scope（`global` / `team` / `instance`）不校验。

## 4. POST `/api/sessions/register`

> **调用方**：agent 容器内 bootstrap 脚本（非前端）。前端仅作为 `instance.session_registered` / `instance.activated` 事件的 WS 下行消费者。

**用途**：Role Instance 进程启动后，把自己的真实 session id（如 `claudeSessionId`）回写给后端 roster，并把状态从 `PENDING` 推进到 `ACTIVE`。

**通常不由前端直接调**，由 agent 容器内的 bootstrap 脚本调。这里留接口记录格式。

### Request

```
POST /api/sessions/register
Content-Type: application/json

{
  "instanceId": "inst_xxx",        // 必填
  "claudeSessionId": "sess_yyy"    // 可选；string 非空
}
```

### Response

**200**：
```json
{ "status": "ACTIVE" }
```

**400** — `instanceId` 缺失或非字符串、`claudeSessionId` 传了但不是非空字符串：
```json
{ "error": "instanceId is required" }
```

**404** — 找不到 `instanceId`：
```json
{ "error": "role instance 'inst_xxx' not found" }
```

### 副作用

1. 若传 `claudeSessionId` → 写入 `role_instances.claude_session_id`，emit `instance.session_registered` bus 事件。
2. 若实例当前 `status === 'PENDING'` → `activate()` 推进到 `ACTIVE`，emit `instance.activated`。

两个事件都会走 bus 订阅链 → 通过 `notification.subscriber` 判断是否要通知前端 → `ws-broadcaster` 按订阅投递。前端订阅 `instance:<id>` 或 `global` 都能收到。

## 5. 单用户场景速查

- WS 直接连 `/ws/events?userId=local`
- 订阅 `user:local` 是合法的（自己订阅自己）
- 所有 notification 配置的 `userId` 字段默认 `null`（系统缺省），通知推到 `user:local`（缺省兜底）
- 不需要登录、不需要 token、不需要 cookie

多用户扩展时：ws-upgrade 加 token 校验、notification-store 按 userId 分配置、visibility-filter 按 principal 分规则。**前端 API 形状不变**。
