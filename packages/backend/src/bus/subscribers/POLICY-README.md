# policy.subscriber —— 白名单事后强制下线

业务胶水订阅者。把 `driver.tool_call` 事件接到 policy 纯净层
（`rule-loader` / `rule-merger` / `rule-matcher`）做判定，违规时**直接**
emit `instance.offline_requested(requestedBy='policy-enforcer', reason)`。

> 权威设计：`packages/backend/docs/phase-sandbox-acp/stage-5/TASK-LIST.md` §M7
> 设计文档：`packages/backend/docs/phase-sandbox-acp/stage-5-security.md` §3（注：该文档里的
> `policy.violated` 两跳链路已在 TASK-LIST M5/M7 处**取消**）

---

## 1. 职责

- **订阅** `driver.tool_call`
- **查规则**：`ruleLoader.getGlobalRules()` + `ruleLoader.getTemplateAllow(driverId)` → `mergeRules` → `EffectiveRules`
- **判定**：
  - `deny` 命中 → `reason='explicit_deny'`
  - `configured=false` → **放行**（default allow，未配置白名单的 instance 不拦截）
  - `configured=true` 且 `no_match` → `reason='not_in_whitelist'`
  - `allow` 命中 → 放行
- **违规**：**直接** emit `instance.offline_requested(instanceId=event.driverId, requestedBy='policy-enforcer', reason, correlationId)`

**不** emit `policy.violated`（该事件已从 M5 取消）。
**不** 订阅 `driver.started` / `driver.stopped`（不再需要 driverId→instanceId 反查）。

---

## 2. driverKey 口径（钉死）

```
driverKey === instanceId === event.driverId
```

与 Stage 2/3 的 `driverId === instanceId` 保持一致（P1-8 钉死）。因此：

- `ruleLoader.getTemplateAllow(event.driverId)` 直接用 driverId 当 key 查模板白名单；
- 违规时 `instance.offline_requested.instanceId = event.driverId`，不做反查。

原 stage-5-security.md §3.2 里的 `driverToInstance` 映射已移除（Stage 5 内无消费者）。

---

## 3. 时序图（单跳）

```
 AgentDriver ──emit──► driver.tool_call(driverId, name, input, correlationId)
                         │
                         ▼
               policy.subscriber.handler
                         │
                         ▼
          ruleLoader.getTemplateAllow(driverId)
          ruleLoader.getGlobalRules()
                         │
                         ▼
                   mergeRules()
                         │
                         ▼
                    evaluate(name, rules)
                         │
            ┌────────────┼────────────────┐
            ▼            ▼                ▼
        allow /       deny             no_match
       configured      │                  │
        =false  ◄──────┘           ┌──────┴──────┐
        (放行)                     ▼             ▼
                         configured=false  configured=true
                          (default allow)  not_in_whitelist
                                             │
                                   ┌─────────┴─────────┐
                                   ▼                   ▼
                              explicit_deny       not_in_whitelist
                                   │                   │
                                   └───────┬───────────┘
                                           ▼
                    emit instance.offline_requested(
                      instanceId = event.driverId,
                      requestedBy = 'policy-enforcer',
                      reason,
                      correlationId ← tool_call.correlationId
                    )
                                           │
                                           ▼
                              roster.subscriber → PENDING_OFFLINE
                              member-driver/lifecycle → driver.kill
                              log.subscriber → 审计（requestedBy='policy-enforcer'）
```

**单跳**：违规判定后直接一条 `instance.offline_requested`，不再走
`policy.violated → 另一订阅者 → offline_requested` 的双事件链路。
双事件链对事件顺序敏感（第三方订阅者可能截胡），单跳消除这个风险面。

---

## 4. correlationId 透传

`driver.tool_call.correlationId` 原样复制到 `instance.offline_requested.correlationId`。
场景：前端追踪一次工具调用引发的级联下线（tool_call → offline → roster 更新
→ lifecycle 停 driver → driver.stopped），全链路 ID 一致即可串联日志。

---

## 5. 审计链路

不再有 `policy.violated` 作为独立审计事件。审计通过 `log.subscriber`
订阅 `instance.offline_requested`，按 `requestedBy === 'policy-enforcer'`
过滤即可识别"策略强制下线"。违规原因通过 `reason` 字段读出：
`'explicit_deny'` / `'not_in_whitelist'`。

其他 `requestedBy` 来源（team-cascade / manual / team-disband / api 等）
不带 `reason`，语义明确区分。

---

## 6. 竞态分析

本 subscriber 逻辑无状态：每条 `driver.tool_call` 独立查规则、独立判定、独立 emit。
可能的竞态点：

1. **规则热加载并发**：`ruleLoader` 在 `fs.watch` 触发时会重写内存快照。
   本 subscriber 每次调用 `getGlobalRules()` 拿到的是**当前快照**，单次判定内部一致；
   不同 tool_call 可能看到不同快照，这是期望行为（热加载本就允许时间差）。
2. **同一 driverId 连发 tool_call**：bus 按 emit 顺序同步分发
   （`EventBus.emit` → `subject.next`），每条独立走一次判定流程，
   违规会连续 emit 多条 `instance.offline_requested`。上游
   `roster.subscriber` 对重复 offline_requested 幂等（PENDING_OFFLINE → PENDING_OFFLINE）。
3. **违规当次 emit 失败**：`eventBus.emit` 在 try-catch 内，不会把异常冒泡到
   `driver.tool_call` 发射源。handler 自身也包一层 try-catch，单条失败不阻塞后续。

---

## 7. 错误传播路径

| 发生位置 | 表现 | subscriber 处理 | 最终状态 |
|---------|------|----------------|---------|
| `ruleLoader.getTemplateAllow` 抛错 | 注入函数实现抛 | handler try-catch 吞掉 → stderr 日志 | 该 tool_call 不拦截（失败开放 fail-open）|
| yaml 解析错 | rule-loader 已保留上次快照，不抛 | —— | 沿用上次规则 |
| `eventBus.emit` 抛错 | 极少见（EventBus 内部已 try-catch）| handler try-catch 兜底 | stderr 日志，单条丢失 |

**fail-open 是有意选择**：策略判定挂掉时继续放行，优于把整个 bus 的后续订阅者
卡住。违规检测是次要安全层，不是主逻辑路径；fail-close 会把产品主路径一起带崩。

---

## 8. 接口签名

```ts
import type { RuleLoader } from '../../policy/rule-loader.js';
import type { Subscription } from 'rxjs';
import type { EventBus } from '../events.js';

export interface PolicySubscriberDeps {
  ruleLoader: RuleLoader;  // M2a rule-loader，外部注入
}

export interface PolicySubscriberConfig {
  enabled: boolean;        // false → 返回空 Subscription，不注册任何订阅
  configPath?: string;     // M2a 内部用；subscribePolicy 本身不读
}

export function subscribePolicy(
  config: PolicySubscriberConfig,
  deps: PolicySubscriberDeps,
  eventBus?: EventBus,     // 默认 defaultBus
): Subscription;
```

**使用示例**（M8 boot 路径）：

```ts
const ruleLoader = createRuleLoader({
  configPath: cfg.policy?.configPath,
  readTemplateWhitelist: (id) => readPrimaryAgentWhitelist(id),
});
masterSub.add(subscribePolicy({ enabled: cfg.policy?.enabled ?? false }, { ruleLoader }));
// teardown 时外部自行 ruleLoader.close()
```

---

## 9. 为什么 policy 是"事后拦截"

`driver.tool_call` 是 ACP agent **已经在 driver 侧声明要调用工具**的事件，
bus 订阅者看到时工具已经开始执行。Stage 5 的策略层做的是**事后强制下线**
（违规 → 把整个 instance 拉下线），而非"阻止此次调用"。

**前置拦截**需要改 AgentDriver 把 tool_call 挂起 → 查 policy → 放行/拒绝，
属于 Stage 5 范围外的 AgentDriver 能力增强（新 Stage）。详见
`stage-5-security.md` §3.1 的边界说明。

---

## 10. 额外契约变更

本 M7 为了透传违规原因，给 `InstanceOfflineRequestedEvent` 加了可选字段：

```ts
export interface InstanceOfflineRequestedEvent extends BusEventBase {
  type: 'instance.offline_requested';
  instanceId: string;
  requestedBy: string;
  reason?: 'explicit_deny' | 'not_in_whitelist' | string;  // ← M7 新增
}
```

向后兼容：其他 emit 源（team-cascade / manual）不带 `reason`，行为不变。
订阅方（`roster.subscriber` / `team.subscriber` / `member-driver/lifecycle`）不读 `reason` 字段，只
`log.subscriber` 按需审计读取。
