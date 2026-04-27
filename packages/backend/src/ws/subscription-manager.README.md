# ws/subscription-manager

**一句话：** per-connection 的 WS 订阅状态表，给 `ws-broadcaster` 做"这条 bus 事件是否应该推给这条连接"的路由判定。

- 纯数据结构 + 纯函数 `match`，无运行时外部依赖
- 只 `import type` bus/types 与同目录 protocol
- 不做越权校验（那是 ws-handler 的事，见下文）

## 接口

```typescript
export interface ClientSubscription {
  scope: 'global' | 'team' | 'instance' | 'user';
  id: string | null; // global 固定 null；其余为目标 id
}

export class SubscriptionManager {
  addConn(connectionId: string): void;
  removeConn(connectionId: string): boolean;
  subscribe(connectionId: string, sub: ClientSubscription): void;
  unsubscribe(connectionId: string, sub: ClientSubscription): void;
  match(connectionId: string, event: BusEvent): boolean;
  list(connectionId: string): ClientSubscription[];
  stats(): { conns: number; totalSubs: number };
}
```

## 使用示例

```typescript
const mgr = new SubscriptionManager();
mgr.addConn('conn_abc');
mgr.subscribe('conn_abc', { scope: 'team', id: 'team_01' });

const event: BusEvent = {
  type: 'team.member_joined',
  ts: '...', source: '...',
  teamId: 'team_01', instanceId: 'inst_1', roleInTeam: null,
};
if (mgr.match('conn_abc', event)) {
  // broadcaster 决定把事件推给这条 WS
}
```

## match 优先级表

规则自上而下短路；任一命中即 `true`，全部未命中 `false`。

| # | 订阅形态            | 命中条件                                                     | 例                                     |
|---|---------------------|--------------------------------------------------------------|----------------------------------------|
| 1 | `global:`           | 任意 BusEvent                                                | 任何事件                               |
| 2 | `instance:<id>`     | `event.instanceId === <id>` **或** `event.driverId === <id>` | `driver.text`, `instance.created`      |
| 3 | `team:<id>`         | `event.teamId === <id>`                                      | `team.member_joined`, `team.created`   |
| 4 | `user:<id>`         | `event.type ∈ comm.*` 且 `event.to === 'user:<id>'`          | `comm.message_sent` to=user:u1         |
| — | 其他                | drop                                                          |                                        |

**反例集（被设计成不命中）：**

- `user:u1` 订阅 + `driver.text` 事件 → drop（非 comm.* 不走用户订阅）
- `user:u1` 订阅 + `comm.message_sent from=user:u1` → drop（from 不参与，防回显重复）
- `team:t1` 订阅 + `driver.text`（只有 driverId，无 teamId）→ drop
- `instance:i1` 订阅 + `team.member_joined teamId=t1 instanceId=i1` → **命中**（规则 2 优先级比 3 高，先按 instanceId 匹配即返 true；如果前端只订了 instance 不订 team 仍会收到，符合直觉）

## 为什么 user scope 看 `envelope.to` 而不是 `from`

user 订阅的语义是"发给我的消息路由到我这条 WS 连接"。`to` 才是"接收方"地址：

- agent 主动 `send_msg(to:'user:u1', ...)` → comm.message_sent `to='user:u1'` → u1 的 WS 收到
- 用户自己发出去的消息（`from='user:u1'`）由前端已经拿到 ack / local echo，不需要服务端再推一份；推了反而导致列表里一条消息出现两次

这就是为什么 match 只看 `to`，`from` 完全不参与用户订阅匹配。

## 越权校验不在本模块做

本模块只管"订阅了什么"，不管"是否有权订阅"。`scope='user' && id !== ctx.userId` 的越权在 **ws-handler** 拦截（回 `error{forbidden}`），拦下后根本不会走到 `subscribe()`。

这样做的原因：

- 保持本模块纯数据结构，零业务依赖，可独立单测
- 权限逻辑集中在 ws-handler，未来要扩（团队权限、filter 前置）只动一处
- subscription-manager 不需要知道 ctx.userId / DB / comm.registry 等上下文

## 边界行为

- **未 addConn 的 connectionId**：`subscribe` / `unsubscribe` 静默 no-op；`match` 永远 `false`；`list` 返回 `[]`。防御式设计，因为 ws close 与消息到达之间存在竞态。
- **addConn 幂等**：重复 add 同一 id 不重置既有订阅。
- **去重**：`subscribe` 同一 `(scope, id)` 多次等价一次，内部用 `Set<string>` 保证。
- **global 订阅忽略 id**：即使调用方传了 `{scope:'global', id:'x'}`，内部规范化到 `global:`，`list` 也会回 `{scope:'global', id:null}`。
- **list 返回拷贝**：外部改返回值不会破坏内部 Set。

## 不做的事

- 不 emit bus 事件
- 不写 DB
- 不做 gap-replay（那是 W1-C `gap-replayer`）
- 不做 WS 连接管理（那是 ws-handler / ws-upgrade）
- 不做越权校验（ws-handler）
- 不做可见性过滤（W2-4 `visibility-filter`）
