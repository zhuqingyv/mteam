# notification & visibility

> **面向**：前端 + 后端内部。分两部分：
> - **配置结构（ProxyMode / CustomRule / VisibilityRule）** — 前端 UI 配置面，通过 HTTP 写入（notification-config 建议端点 / visibility 规则端点）。
> - **执行与路由（proxy-router / visibility-filter 算法）** — 后端内部机制，前端无需调用，只消费结果。
> - **`notification.delivered` WS 事件** — 前端（WS 客户端）消费，agent 不收。

通知代理 + 可见性过滤，两套独立机制。通知决定"谁收"，可见性决定"谁能看"。

源码：`packages/backend/src/notification/{types,proxy-router}.ts`、`packages/backend/src/filter/types.ts`。

## 1. ProxyMode

```ts
type ProxyMode = 'proxy_all' | 'direct' | 'custom';

interface NotificationConfig {
  id: string;            // 单用户场景固定 'default'
  userId: string | null; // null = 系统缺省
  mode: ProxyMode;
  rules?: CustomRule[];  // 仅 custom 模式有意义
  updatedAt: string;
}
```

| mode | 行为 |
|------|------|
| `proxy_all` | 白名单事件代理给 primary agent。primary 离线 → fallback `direct`（后端 warn） |
| `direct`    | 直接推给前端 `user:<userId ?? 'local'>` 连接 |
| `custom`    | 按 `rules` 自顶向下首命中；全不命中 → drop（静默） |

字面量**只能**是这三个。`full_proxy` / `no_proxy` 是旧名，不要用。

## 2. CustomRule

```ts
type CustomRuleTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; instanceId: string }
  | { kind: 'primary_agent' }
  | { kind: 'drop' };

interface CustomRule {
  matchType: string;   // 尾部 '.*' 通配
  to: CustomRuleTarget;
}
```

**匹配语义**：`matchType` 以 `.*` 结尾 → 前缀匹配（`'team.*'` 命中所有 `team.xxx`）；否则完全相等。不支持前缀/中缀通配。

**特例**：`custom` 模式下 `to={kind:'primary_agent'}` 命中时，即便 primary 离线也**不降级**，由订阅层退回 user（前端仍收 `notification.delivered`）。

## 3. NOTIFIABLE_EVENT_TYPES

通知白名单 9 种（不在此集合的事件不走通知，只走普通 WS 订阅）：

```
instance.created           team.created              container.crashed
instance.deleted           team.disbanded            driver.error
instance.offline_requested team.member_joined
                           team.member_left
```

## 4. `notification.delivered` 前端处理

后端路由为 `user` 目标时，不重推原事件，而是 emit 一条**通知指针**：

```ts
interface NotificationDeliveredEvent {
  type: 'notification.delivered';
  ts: string;
  target: { kind: 'user'; id: string } | { kind: 'agent'; id: string };
  sourceEventType: string;  // 原事件 type，如 'team.created'
  sourceEventId: string;    // 原事件 id（fallback 链见下）
}
```

**sourceEventId fallback**：`comm.*` → `messageId`；其他 → `correlationId`；兜底 → `${type}@${ts}`。

**前端约定**：
- 若同时订阅 `global`（收原事件）和 `user:<me>`（收通知副本），**按 `sourceEventId` 从本地缓存找原事件，不要重复渲染**。
- `notification.delivered` 本身**不进 messages 表**，断线重连 gap-replay 不补。断线期间丢的通知通过原事件重放恢复。
- 展示侧用 `sourceEventType` 决定渲染模板。

```json
{
  "type": "notification.delivered",
  "ts": "2026-04-25T03:12:55.921Z",
  "target": { "kind": "user", "id": "local" },
  "sourceEventType": "team.member_joined",
  "sourceEventId": "team.member_joined@2026-04-25T03:12:55.900Z"
}
```

## 5. VisibilityRule

可见性与通知独立：通知"谁收"，可见性"谁能看"。

```ts
type ActorPrincipal =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; instanceId: string }
  | { kind: 'system' };

type RuleTarget = ActorPrincipal | { kind: 'team'; teamId: string };
// team 只能做 target，不能做 principal

interface VisibilityRule {
  id: string;
  principal: ActorPrincipal;  // 谁看
  target: RuleTarget;          // 看谁（发出/发给 target 的事件）
  effect: 'allow' | 'deny';
  note?: string;
  createdAt: string;
}

type VisibilityDecision =
  | { decision: 'allow'; byRuleId: string | 'default_allow' }
  | { decision: 'deny'; byRuleId: string };
```

**算法**（`filter/visibility-filter.ts`）：
1. 从事件抽 target 集（`comm.*` 取 from+to；`team.*` 取 teamId；`instance.*` 取 instanceId 等）
2. 抽不出 target → 全局事件 → `default_allow`
3. **deny 先扫**，命中短路返回 `deny`
4. allow 再扫，命中返回 `allow`
5. 都没命中 → `default_allow`

**deny 永远优先**。不缓存，`upsert` 对后续事件立即生效。

## 6. `default_allow` 本期行为

- **本期**（单用户）策略固定 `default_allow`：没规则命中就放行。
- `byRuleId === 'default_allow'` 表示"无规则命中，兜底放行"，和"用户显式配 allow"不同。UI 按需区分。
- 未来接多租户白名单模式，会加 `default_policy: 'allow' | 'deny'` 配置注入，算法不改。

```json
{
  "id": "rule-1",
  "principal": { "kind": "agent", "instanceId": "inst_frontend" },
  "target": { "kind": "team", "teamId": "team_alpha" },
  "effect": "deny",
  "note": "前端 agent 不看 alpha 团队讨论",
  "createdAt": "2026-04-25T03:00:00.000Z"
}
```
