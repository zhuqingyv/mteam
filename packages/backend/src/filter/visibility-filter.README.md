# visibility-filter (W2-4)

业务胶水：把"一条 bus 事件 + 一个观测主体"翻译成 `allow` / `deny` 判定，给 `ws-broadcaster` 推送前做门禁。

## 一句话

`canSee(principal, event)` → `boolean`；`decide(principal, event)` → `VisibilityDecision`。
规则来源是 `FilterStore`（W1-F），每次判定直接读 store，不缓存。

## 接口

```typescript
import type { BusEvent } from '../bus/types.js';
import type {
  ActorPrincipal,
  FilterStore,
  VisibilityDecision,
} from './types.js';

export interface VisibilityFilter {
  canSee(principal: ActorPrincipal, event: BusEvent): boolean;
  decide(principal: ActorPrincipal, event: BusEvent): VisibilityDecision;
}

export function createVisibilityFilter(store: FilterStore): VisibilityFilter;
```

## 使用示例（ws-broadcaster 侧）

```typescript
import { createVisibilityFilter } from './filter/visibility-filter.js';
import { createFilterStore } from './filter/filter-store.js';

const filter = createVisibilityFilter(createFilterStore());

bus.events$.subscribe((event) => {
  for (const conn of activeConnections()) {
    if (!filter.canSee(conn.principal, event)) continue;
    conn.send({ type: 'event', event });
  }
});
```

## 算法（伪码）

```
decide(principal, event):
  targets = extractTargets(event)              # 抽出事件涉及的 user/agent/team
  if targets.empty: return default_allow

  rules = store.listForPrincipal(principal)
  if rules.empty: return default_allow

  for r in rules where r.effect == 'deny':
    if any(match(t, r.target) for t in targets):
      return deny(r.id)                        # 先扫 deny，一命中就短路

  for r in rules where r.effect == 'allow':
    if any(match(t, r.target) for t in targets):
      return allow(r.id)

  return default_allow
```

`VisibilityDecision` 的 `byRuleId`：

- `allow` 分支可以是 `'default_allow'` 字面量（兜底）或具体规则 id
- `deny` 分支必须是具体规则 id（类型层强制，见 `types.ts`）

## target 抽取表

| 事件类型 | 抽出的 target |
|---|---|
| `comm.message_sent` / `comm.message_received` | `[parse(from), parse(to)]`（parse 不出的 drop） |
| `comm.registered` / `comm.disconnected` | `[parse(address)]`（system 地址 → 空数组） |
| `driver.started/stopped/error/thinking/text/tool_call/tool_result/turn_done` | `[agent:driverId]` |
| `instance.created/activated/offline_requested/deleted/session_registered` | `[agent:instanceId]` |
| `container.started/exited/crashed` | `[agent:agentId]`（host 模式 agentId===instanceId） |
| `primary_agent.started/stopped/configured` | `[agent:agentId]` |
| `team.created/disbanded` | `[team:teamId]` |
| `team.member_joined/member_left` | `[team:teamId, agent:instanceId]`（任一命中即命中） |
| `template.*` / `mcp.*` / `cli.*` | `[]` → `default_allow` |

`comm.*` 的 address 格式：`user:<id>` / `agent:<id>` / `team:<id>` / `system`。解析不了或 kind 不是这三种的（例如 `system`），返回 null；如果事件两边都解析不出 target，算法走 `default_allow`。

## 默认策略扩展点

本模块默认 `default_allow`。若未来接多租户/多用户且要求白名单模式，新增
`default_policy: 'allow' | 'deny'` 配置入 `filter_configs` 表，由
`createVisibilityFilter(store, opts)` 注入；**不要**硬改本算法。
arch-ws-b 审查同意本期保留 default_allow。

## 时序图

```
bus.emit(event)
      │
      ▼
ws-broadcaster 遍历每个活跃连接
      │
      ├──► filter.canSee(conn.principal, event)
      │         │
      │         ▼
      │    extractTargets(event) ── 纯函数，同步
      │         │
      │         ▼
      │    store.listForPrincipal(principal) ── 同步 SQLite 读
      │         │
      │         ▼
      │    deny 短路 → allow 命中 → default_allow
      │
      ├──► true  → conn.send(event)
      └──► false → drop（不日志，避免观察者视角污染）
```

## 竞态分析

### R1：规则运行期变更（`store.upsert` / `store.remove`）

- **场景**：管理员通过 HTTP/Panel 写入新规则，**同一瞬间**有事件正在被分发。
- **分析**：`bus.emit` 是 RxJS Subject 同步派发（见 `bus/events.ts`），`ws-broadcaster` 的订阅回调也是同步。单个事件内，每个连接 `canSee` 顺序执行；一个事件完全分发完之前，JS 事件循环不会切进另一个 tick。因此：
  - 如果 `upsert` 在 `emit` 之前调用 → 本次事件即可看到新规则。
  - 如果 `upsert` 在 `emit` 之后调用 → 本次事件按旧规则判定，下一个事件按新规则。
  - **不会出现"半应用"**：不会有一个连接按新规则判、另一个连接按旧规则判，因为 `store.listForPrincipal` 的 SQLite 语句是单次 prepared statement 调用，原子。
- **策略**：不缓存规则列表，每次 `canSee` 都重新 `listForPrincipal`。牺牲一点性能换一致性。如果未来 QPS 升高出现瓶颈，上 store 侧的 version counter + LRU，而不是在 filter 里缓存。

### R2：principal 本身的身份切换

- **场景**：同一 WS 连接先作为 `user:u1` 注册，然后重新绑定到 `user:u2`（多账号场景）。
- **分析**：principal 对象由调用方（ws-handler）持有，filter 不缓存。调用方在切身份时必须同步替换 principal 引用再发下一条事件，否则会用旧 principal 判。
- **策略**：责任下推到 ws-handler（README 文档约束）。本模块只保证"给什么 principal 就按什么 principal 判"。

### R3：store 被 close（DB 连接已销毁）

- **场景**：测试/关服流程里 `closeDb()` 发生，但还有 in-flight 事件进入 filter。
- **分析**：`store.listForPrincipal` 会抛（SQLite 报 "database is closed"）。
- **策略**：不在 filter 层做 try-catch（"数据库挂了"是基础设施错，不该被可见性层吞），让错误沿调用栈回到 ws-broadcaster 决定 drop 或 log。对应测试策略：生命周期管理放到 ws-broadcaster 侧的测试里验证。

## 错误传播路径

| 谁出错 | 传播到 | 最终状态 |
|---|---|---|
| `store.listForPrincipal` 抛（DB 挂了） | `canSee` / `decide` 抛 | ws-broadcaster 决策：drop event + log；不触 process crash |
| `extractTargets` 遇到未知 event.type | 落到 `default` 分支 → `[]` → `default_allow` | 未来新增事件类型时默认可见，向前兼容；如需默认 deny 要改算法并加守门测试 |
| parseAddress 解析失败 | 返回 null，该 target 被 drop | 事件有可能抽不出任何 target → `default_allow` |

## 与 W1-B subscription-manager 的职责划分

- `subscription-manager.match`：**客户端声明了想订阅什么 scope**（global/team/instance/user），按订阅声明过滤。
- `visibility-filter.canSee`：**服务端决定这个主体能不能看**（基于规则表）。

两者**串联**：先 match 再 canSee。match 通过但 canSee 拒，事件也不推。

## 测试

`__tests__/visibility-filter.test.ts`：

- R2-1 无规则 → default_allow（三种"无命中"组合）
- R2-2 deny 短路
- R2-3 allow 明确放行 + byRuleId 不是 `default_allow`
- R2-4 deny 优先（含 comm 事件 from/to 一个命中 deny 一个命中 allow 的情况）
- R2-5 运行期 upsert / remove 立即生效
- target 抽取各分支（driver / container / instance / team / comm.address）
- system principal 链路
- 模块纯净：不 `import` bus/comm 运行时代码（`import type` 允许）

运行：

```
cd packages/backend && bun test src/filter/__tests__/visibility-filter.test.ts
```
