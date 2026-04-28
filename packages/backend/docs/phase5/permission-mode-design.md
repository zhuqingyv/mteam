# ACP 权限模式设计（Phase 5）

> 范围：将所有 agent（主 Agent + 成员）的 ACP 权限审批统一为两种模式——全自动（auto）和半自动（manual）。全自动即原 autoApprove=true 行为；半自动时权限请求透传给前端，用户自行 allow/deny。默认全自动。支持 Settings Registry 查询和设置，实时切换走 WS。

---

## 1. 现状分析

### 1.1 当前实现

`driver.ts:113-127` 的 `requestPermission` 回调：

```ts
const autoApprove = this.config.autoApprove === true;
requestPermission: async (params) => {
  if (!autoApprove) return { outcome: { outcome: 'cancelled' } };
  const first = params.options[0];
  if (!first) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: first.optionId } };
},
```

- `autoApprove=true` → 选 `options[0]`（ACP 约定第一个永远是 `allow_*` 类），等价于用户点了"允许"。**正确。**
- `autoApprove=false` → 返回 `{ outcome: 'cancelled' }`。语义是"全拒"，agent 收到 `Tool use aborted`。**不对——应该是透传给用户决策，而不是直接拒绝。**

### 1.2 数据来源

| 实体 | 字段 | 位置 | 默认值 |
|---|---|---|---|
| 主 Agent | `autoApprove: boolean` | `primary_agent` 表 / `PrimaryAgentRow` | `true` |
| 成员 | `autoApprove: boolean` | `role_instances` 表 / `RoleInstanceProps` | `false`（成员默认保守） |
| DriverConfig | `autoApprove?: boolean` | `agent-driver/types.ts:49` | `undefined`（= false） |

### 1.3 ACP SDK 权限协议（v0.20.0 / claude-agent-acp@0.31.0）

**入参 `RequestPermissionRequest`：**
- `sessionId: SessionId`
- `toolCall: ToolCallUpdate` — 触发权限请求的 tool 信息
- `options: PermissionOption[]` — agent 给出的按钮列表

**`PermissionOption`：**
- `optionId: string` — 唯一 ID
- `name: string` — 显示文字
- `kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'`

**返回 `RequestPermissionResponse`：**
```ts
outcome: { outcome: 'cancelled' } | { outcome: 'selected', optionId: string }
```

只有两种 outcome。允许/拒绝通过 `selected.optionId` 的语义区分。

**claude-agent-acp 固定 options 排序：**
```js
[
  { kind: 'allow_always', name: describeAlwaysAllow(...), optionId: 'allow_always' },
  { kind: 'allow_once',   name: 'Allow',                  optionId: 'allow'        },
  { kind: 'reject_once',  name: 'Reject',                 optionId: 'reject'       },
]
```

### 1.4 问题总结

1. `autoApprove=false` 语义错误：应该是"人工审批"而非"全拒"。
2. boolean 语义不足：只能二选一，未来无法扩展更细粒度的模式。
3. 无 WS 透传链路：没有把权限请求推给前端让用户决策的能力。

---

## 2. 两种模式定义

### 2.1 类型

```ts
type PermissionMode = 'auto' | 'manual';
```

替代原 `autoApprove: boolean`，语义更清晰：

| 模式 | 语义 | 对应原值 | 行为 |
|---|---|---|---|
| `auto` | 全自动 | `autoApprove=true` | `requestPermission` 直接选 `options[0]`（allow_*） |
| `manual` | 半自动 | `autoApprove=false`（修正后） | 透传给前端，用户自行选择 option |

### 2.2 默认值

- **所有 agent 默认 `auto`。** 主 Agent 和成员统一默认行为，减少认知负担。
- 全局可通过 Settings 覆盖默认值（`system.defaultPermissionMode`）。
- 每个实例可单独覆盖（instance 级 > 全局默认）。

### 2.3 DB 字段迁移

| 表 | 旧字段 | 新字段 | 类型 | 默认值 |
|---|---|---|---|---|
| `primary_agent` | `auto_approve INTEGER DEFAULT 1` | `permission_mode TEXT DEFAULT 'auto'` | TEXT | `'auto'` |
| `role_instances` | `auto_approve INTEGER DEFAULT 0` | `permission_mode TEXT DEFAULT 'auto'` | TEXT | `'auto'` |

迁移 SQL（单次 ALTER，无回滚需求）：
```sql
-- primary_agent
ALTER TABLE primary_agent ADD COLUMN permission_mode TEXT DEFAULT 'auto';
UPDATE primary_agent SET permission_mode = CASE WHEN auto_approve = 1 THEN 'auto' ELSE 'manual' END;

-- role_instances
ALTER TABLE role_instances ADD COLUMN permission_mode TEXT DEFAULT 'auto';
UPDATE role_instances SET permission_mode = CASE WHEN auto_approve = 1 THEN 'auto' ELSE 'manual' END;
```

旧 `auto_approve` 列保留不删，新代码只读写 `permission_mode`，避免迁移风险。

---

## 3. 全自动模式（auto）——已有，不改

`driver.ts` `requestPermission` 回调中 `permissionMode === 'auto'` 分支：

```ts
// 选 options[0]，ACP 约定第一个是 allow_* 类
const first = params.options[0];
if (!first) return { outcome: { outcome: 'cancelled' } };
return { outcome: { outcome: 'selected', optionId: first.optionId } };
```

行为不变，只是判断条件从 `autoApprove === true` 改为 `permissionMode === 'auto'`。

---

## 4. 半自动模式（manual）——新增

### 4.1 完整链路

```
ACP requestPermission(params)
  → driver.ts 判断 permissionMode
  → 'manual'
    → 生成 requestId（UUID）
    → 存入 pendingPermissions Map
    → 通过 WS 推下行 permission_requested 给前端
    → 前端弹窗展示 toolCall + options
    → 用户选择一个 option
    → 前端发上行 permission_response { requestId, optionId }
    → ws-handler 路由到 handle-permission
    → 从 pendingPermissions Map 取出并 resolve Promise
    → driver.ts requestPermission 返回给 ACP
    → ACP agent 拿到 outcome 继续执行
```

### 4.2 Pending Map

`requestPermission` 是 async 函数。manual 模式下需要 await 一个 Promise，这个 Promise 由 WS 上行的 `permission_response` resolve。

**新建文件 `ws/handle-permission.ts`：**

```ts
interface PendingPermission {
  resolve: (result: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  instanceId: string;
}

// 全局单例。key = requestId
const pendingPermissions = new Map<string, PendingPermission>();

const PERMISSION_TIMEOUT_MS = 30_000; // 30s 无响应自动 cancelled

/**
 * driver.ts 的 manual 分支调用此函数：
 *   1. 生成 requestId
 *   2. 建 pending entry（含超时定时器）
 *   3. 通过 WS broadcaster 推 permission_requested 下行
 *   4. 返回 Promise，等用户响应或超时
 */
export function createPendingPermission(
  requestId: string,
  instanceId: string,
): Promise<{ outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(requestId);
      resolve({ outcome: 'cancelled' }); // 超时 = 自动取消，不 reject
    }, PERMISSION_TIMEOUT_MS);
    pendingPermissions.set(requestId, { resolve, reject, timer, instanceId });
  });
}

/**
 * WS 上行 permission_response 到达时调用。
 * 找到 pending entry → clearTimeout → resolve。
 * 找不到 → 已超时或重复响应，忽略。
 */
export function resolvePermission(
  requestId: string,
  optionId: string,
): boolean {
  const entry = pendingPermissions.get(requestId);
  if (!entry) return false; // 已超时或不存在
  clearTimeout(entry.timer);
  pendingPermissions.delete(requestId);
  entry.resolve({ outcome: 'selected', optionId });
  return true;
}

/** 实例销毁时清理所有属于该 instanceId 的 pending。 */
export function cancelAllPending(instanceId: string): void {
  for (const [rid, entry] of pendingPermissions) {
    if (entry.instanceId === instanceId) {
      clearTimeout(entry.timer);
      pendingPermissions.delete(rid);
      entry.resolve({ outcome: 'cancelled' });
    }
  }
}
```

### 4.3 driver.ts 改动

```ts
private async bringUp(): Promise<void> {
  const stream = acp.ndJsonStream(this.handle.stdin, this.handle.stdout);
  const permissionMode = this.config.permissionMode ?? 'auto';
  const client: acp.Client = {
    sessionUpdate: async (params) => {
      const ev = this.adapter.parseUpdate(params.update);
      if (ev) this.emit(ev);
    },
    requestPermission: async (params) => {
      // auto：直接选 options[0]
      if (permissionMode === 'auto') {
        const first = params.options[0];
        if (!first) return { outcome: { outcome: 'cancelled' } };
        return { outcome: { outcome: 'selected', optionId: first.optionId } };
      }
      // manual：透传给前端
      const requestId = randomUUID();
      const pending = createPendingPermission(requestId, this.id);
      // 通过 emitter 发一个新事件类型，bus-bridge 翻译后 WS 广播
      this.emit({
        type: 'driver.permission_requested',
        requestId,
        toolCall: {
          name: params.toolCall?.title ?? 'tool',
          title: params.toolCall?.title,
          input: params.toolCall,
        },
        options: params.options.map(o => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
      });
      const result = await pending;
      return { outcome: result };
    },
  };
  // ... rest unchanged
}
```

### 4.4 超时策略

- **30 秒**无响应 → 自动 `{ outcome: 'cancelled' }`。agent 收到 "Tool use aborted"，不会无限挂起。
- 超时值可后续通过 Settings 配置（`system.permissionTimeoutMs`），本期硬编码 30s。
- 实例销毁（driver.stop）时调 `cancelAllPending(instanceId)` 清理残留。

---

## 5. WS 协议扩展

### 5.1 下行：`permission_requested`

agent 需要权限 + mode=manual 时，后端推给所有订阅了该 instance 或 global 的前端连接。

```ts
interface WsPermissionRequested {
  type: 'permission_requested';
  instanceId: string;
  requestId: string;
  toolCall: {
    name: string;       // tool 名称
    title?: string;     // tool 显示标题
    input?: unknown;    // tool 入参（可选，供前端展示上下文）
  };
  options: Array<{
    optionId: string;   // 回传用
    name: string;       // UI 按钮文字
    kind: string;       // allow_once / allow_always / reject_once / reject_always
  }>;
}
```

### 5.2 上行：`permission_response`

用户在前端弹窗中选择了一个 option 后发送。

```ts
interface WsPermissionResponse {
  op: 'permission_response';
  requestId: string;    // 对应下行的 requestId
  optionId: string;     // 用户选的 option
}
```

### 5.3 下行补充：`permission_resolved`

通知前端某个权限请求已处理（用户选择 / 超时自动取消），前端关闭弹窗。

```ts
interface WsPermissionResolved {
  type: 'permission_resolved';
  requestId: string;
  outcome: 'selected' | 'cancelled' | 'timeout';
  optionId?: string;    // outcome='selected' 时有值
}
```

### 5.4 WsUpstream / WsDownstream 联合扩展

```ts
// protocol.ts
export type WsUpstream = /* 原有 */ | WsPermissionResponse;
export type WsDownstream = /* 原有 */ | WsPermissionRequested | WsPermissionResolved;
```

---

## 6. Settings Registry 注册

### 6.1 全局默认

在 `settings/entries/system.ts` 新增一条 entry：

```ts
{
  key: 'system.defaultPermissionMode',
  label: '默认权限模式',
  description: '新创建 agent 实例的默认 ACP 权限审批模式。auto=全自动（直接批准），manual=半自动（透传给用户）。',
  category: 'system',
  schema: { type: 'string', enum: ['auto', 'manual'] },
  readonly: false,
  notify: 'primary',
  keywords: ['permission', 'auto', 'manual', '权限', '审批', '自动', '半自动'],
  getter: () => readDefaultPermissionMode(),    // 从 system_configs 表读
  setter: (value: unknown) => {
    if (value !== 'auto' && value !== 'manual') {
      throw new Error('system.defaultPermissionMode must be "auto" or "manual"');
    }
    writeDefaultPermissionMode(value);
  },
}
```

存储复用 `system_configs(key, value_json)` 表，key = `'defaultPermissionMode'`。读写函数参照 `quota-config.ts` 模式：

```ts
// system/permission-config.ts
export function readDefaultPermissionMode(): PermissionMode {
  const row = getDb()
    .prepare('SELECT value_json FROM system_configs WHERE key = ?')
    .get('defaultPermissionMode') as { value_json: string } | undefined;
  if (!row) return 'auto';
  const v = JSON.parse(row.value_json);
  return v === 'manual' ? 'manual' : 'auto';
}

export function writeDefaultPermissionMode(mode: PermissionMode): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO system_configs(key, value_json) VALUES(?, ?)')
    .run('defaultPermissionMode', JSON.stringify(mode));
}
```

### 6.2 实例级覆盖

每个 agent 的 `permission_mode` 字段已在 DB 落表（§2.3）。实例级设置通过现有的实例配置 API 修改，不额外注册 SettingEntry。

优先级：**instance.permissionMode > system.defaultPermissionMode**。

DriverConfig 构造时读取逻辑：
```ts
const permissionMode =
  instance.permissionMode        // instance 级
  ?? readDefaultPermissionMode() // 全局默认
  ?? 'auto';                     // 硬编码兜底
```

---

## 7. 文件变更清单

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `agent-driver/types.ts` | **改** | `DriverConfig.autoApprove` → `DriverConfig.permissionMode: PermissionMode`；新增 `DriverPermissionRequestedEvent` |
| `agent-driver/driver.ts` | **改** | `requestPermission` 加 `manual` 分支；`bringUp` 读 `permissionMode`；`stop` 调 `cancelAllPending` |
| `agent-driver/driver-events.ts` | **改** | `DriverOutputEvent` 联合加 `driver.permission_requested` |
| `agent-driver/bus-bridge-translate.ts` | **改** | 新增 `driver.permission_requested` → bus `permission.requested` 翻译 |
| `ws/protocol.ts` | **改** | 新增 `WsPermissionResponse`（上行）、`WsPermissionRequested` / `WsPermissionResolved`（下行） |
| `ws/protocol-guards.ts` | **改** | 新增 `permission_response` op 校验 |
| `ws/ws-handler.ts` | **改** | `routeUpstream` switch 加 `permission_response` case |
| `ws/handle-permission.ts` | **新建** | `createPendingPermission` / `resolvePermission` / `cancelAllPending` + pending Map |
| `primary-agent/types.ts` | **改** | `PrimaryAgentRow.autoApprove` → `permissionMode: PermissionMode` |
| `domain/role-instance.ts` | **改** | `RoleInstanceProps.autoApprove` → `permissionMode: PermissionMode`；`rowToProps` 映射 |
| `settings/entries/system.ts` | **改** | 新增 `system.defaultPermissionMode` entry |
| `system/permission-config.ts` | **新建** | `readDefaultPermissionMode` / `writeDefaultPermissionMode` |
| `bus/types.ts` | **改** | 新增 `permission.requested` 事件类型 |
| `bus/subscribers/ws.subscriber.ts` | **改** | `permission.requested` → WS 下行广播 |
| DB 迁移脚本 | **新建** | ALTER TABLE + UPDATE（§2.3） |

---

## 8. 时序图

```
前端                     WS Handler              driver.ts                ACP Agent
  │                         │                        │                       │
  │                         │                        │◄── requestPermission ─┤
  │                         │                        │    (toolCall, options) │
  │                         │                        │                       │
  │                         │                        │ [mode=auto]           │
  │                         │                        │──► selected(opt[0]) ──►│
  │                         │                        │                       │
  │                         │                        │ [mode=manual]         │
  │                         │                        │  create pending       │
  │◄── permission_requested ┤◄── bus: permission.req ┤  emit event           │
  │    {requestId,toolCall, │                        │  await promise        │
  │     options}            │                        │       ↓ (blocking)    │
  │                         │                        │                       │
  │  用户选择               │                        │                       │
  │── permission_response ──►│                       │                       │
  │   {requestId, optionId} │── resolvePermission ──►│  promise resolved     │
  │                         │                        │──► selected(optionId)─►│
  │                         │                        │                       │
  │◄── permission_resolved ─┤                        │                       │
  │   {outcome:'selected'}  │                        │                       │
  │                         │                        │                       │
  │                    [超时 30s]                     │  promise auto-cancel  │
  │◄── permission_resolved ─┤◄───────────────────────┤──► cancelled ────────►│
  │   {outcome:'timeout'}   │                        │                       │
```

---

## 9. 边界场景

### 9.1 超时

30s 无响应 → `createPendingPermission` 内部 `setTimeout` 触发 → resolve `{ outcome: 'cancelled' }` → agent 收到 "Tool use aborted"。前端收到 `permission_resolved { outcome: 'timeout' }` 关闭弹窗。

### 9.2 实例销毁

`driver.stop()` 时调 `cancelAllPending(instanceId)`：清理该实例所有 pending permission，统一 resolve cancelled。

### 9.3 WS 断连

前端 WS 断开后重连，pending Map 仍在后端内存。如果用户重连后 30s 内发送 `permission_response`，仍然有效。超时后已自动 cancelled，重连发来的响应被忽略（`resolvePermission` 返回 false）。

### 9.4 并发权限请求

同一 agent 可能同时触发多个 tool call → 多个 `permission_requested`。每个 requestId 独立，前端需支持多弹窗/队列。不互斥。

### 9.5 运行时切换模式

通过 Settings `call_setting('system.defaultPermissionMode', 'manual')` 修改全局默认。已运行的 driver 不受影响（mode 在 bringUp 时读取）。需要重启 driver 生效，或后续迭代支持热切换（driver.setPermissionMode）。

---

## 10. 任务拆解

### Wave 1：基础设施（无前端依赖，可并行）

| # | 任务 | 文件 | 依赖 |
|---|---|---|---|
| W1-1 | DB 迁移：两表加 `permission_mode` 列 | 迁移脚本 | 无 |
| W1-2 | `system/permission-config.ts` 读写函数 | 新建 | 无 |
| W1-3 | `settings/entries/system.ts` 注册 entry | 改 | W1-2 |
| W1-4 | `ws/handle-permission.ts` pending Map | 新建 | 无 |

### Wave 2：类型 + 协议（顺序依赖 Wave 1）

| # | 任务 | 文件 | 依赖 |
|---|---|---|---|
| W2-1 | `agent-driver/types.ts` 字段重命名 + 新事件类型 | 改 | W1-1 |
| W2-2 | `primary-agent/types.ts` 字段重命名 | 改 | W1-1 |
| W2-3 | `domain/role-instance.ts` 字段重命名 + rowToProps | 改 | W1-1 |
| W2-4 | `ws/protocol.ts` 新增上下行类型 | 改 | 无 |
| W2-5 | `ws/protocol-guards.ts` 新增 op 校验 | 改 | W2-4 |
| W2-6 | `bus/types.ts` 新增 `permission.requested` 事件 | 改 | 无 |

### Wave 3：核心逻辑（顺序依赖 Wave 2）

| # | 任务 | 文件 | 依赖 |
|---|---|---|---|
| W3-1 | `driver.ts` requestPermission manual 分支 | 改 | W1-4, W2-1 |
| W3-2 | `driver-events.ts` 联合扩展 | 改 | W2-1 |
| W3-3 | `bus-bridge-translate.ts` 新事件翻译 | 改 | W2-6, W3-2 |
| W3-4 | `ws/ws-handler.ts` 路由 permission_response | 改 | W1-4, W2-5 |
| W3-5 | `bus/subscribers/ws.subscriber.ts` 广播 | 改 | W2-6 |

### Wave 4：收尾

| # | 任务 | 文件 | 依赖 |
|---|---|---|---|
| W4-1 | 全量测试更新（autoApprove → permissionMode） | 所有 test | Wave 3 |
| W4-2 | build 验证 | — | W4-1 |
