# Stage 5 — 任务清单

> 源文档：`docs/phase-sandbox-acp/stage-5-security.md`
> 流程：`docs/phase-sandbox-acp/WORKFLOW.md`
>
> **铁律**：
> - 单文件 ≤ 200 行
> - 不 mock DB / bus / router（只允许 mock `dockerode`、时间 `setTimeout`）
> - 每个模块自带 `*.test.ts`
> - 非业务模块不 import 业务代码
> - 每个模块交付必须带 `README.md`
> - Wave 1 **全部完成**才启 Wave 2

---

## 依赖图

```
                     ┌──────────────────────────────────────────────┐
                     │                Wave 1 (纯净层)               │
                     │                                              │
                     │  M1 rule-matcher      M3 container-registry  │
                     │  M2a rule-loader      M4 restart-policy      │
                     │  M2b rule-merger                             │
                     └──────────────────────┬───────────────────────┘
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │                Wave 2 (胶水层)               │
                     │                                              │
                     │  M5 bus/types 扩展事件                        │
                     │  M6 container.subscriber (依赖 M3/M4/M5)     │
                     │  M7 policy.subscriber   (依赖 M1/M2a/M2b/M5) │
                     │  M8 bootSubscribers + server.ts (依赖 M6/M7) │
                     └──────────────────────────────────────────────┘
```

**并行度建议**：Wave 1 五个模块可五人同时并行；Wave 2 中 M5 先于 M6/M7，M6/M7 可并行，M8 最后收口。

---

## Wave 1 — 非业务模块（并行）

### M1 · policy/rule-matcher

| 项目 | 值 |
|------|-----|
| 负责人 | developer (S5-M1) |
| 状态 | 🟢 done |
| 类型 | 非业务（纯函数） |
| 文件 | `packages/backend/src/policy/rule-matcher.ts` |
| 单测 | `packages/backend/src/policy/rule-matcher.test.ts` |
| README | `packages/backend/src/policy/README.md`（M1 建，M2a/M2b 续写） |
| 代码上限 | 80 行 |

**职责**

判断一个 `toolName` 是否命中一条规则。规则表达式支持两种形态：
1. 精确匹配：`Bash`、`mcp__mteam__search_members`
2. 通配符后缀：`mcp__mteam__*`（只支持末位 `*`，不支持中间 `*`）

**接口签名**

```ts
export interface PolicyDecision {
  verdict: 'allow' | 'deny' | 'no_match';
  matchedPattern: string | null;   // 命中哪条规则（调试/审计用）
}

/**
 * 判断单条规则是否覆盖目标工具名。
 * - pattern 末尾为 `*` → 前缀匹配
 * - 其它情况 → 字符串相等
 */
export function matchPattern(pattern: string, toolName: string): boolean;

/**
 * 综合评估：先看 deny 列表，命中直接 deny；否则看 allow 列表，命中 allow，未命中 no_match。
 * 调用方根据 no_match + 有无白名单配置决定默认策略。
 */
export function evaluate(
  toolName: string,
  rules: { allow: string[]; deny: string[] },
): PolicyDecision;
```

**测试点（≥ 8 条）**

- 精确匹配命中 / 不命中
- 通配符前缀匹配命中（`mcp__mteam__*` vs `mcp__mteam__search`）
- 通配符不跨段 `*` 只在末位
- deny 命中时 allow 同样匹配也返回 deny（deny 优先级 > allow）
- 空规则 → `no_match`
- `*` 单独作为 pattern → 匹配一切
- 大小写敏感（`Bash` ≠ `bash`）
- 不支持的模式（中间 `*`）原样精确匹配，不抛

**依赖**：零。纯字符串处理。

**交付物**

- [ ] `rule-matcher.ts` ≤ 80 行
- [ ] `rule-matcher.test.ts` ≥ 8 条 case 全绿
- [ ] `README.md` 写上"规则语法 + 使用示例"（约 30 行）

---

### M2a · policy/rule-loader

| 项目 | 值 |
|------|-----|
| 负责人 | dev-m2a |
| 状态 | 🟢 done |
| 类型 | 非业务（IO 层） |
| 文件 | `packages/backend/src/policy/rule-loader.ts` |
| 单测 | `packages/backend/src/policy/rule-loader.test.ts` |
| README | 续写 `packages/backend/src/policy/README.md` |
| 代码上限 | 120 行 |

**职责**

纯 IO 层，把两个来源的原始数据拉出来并缓存；不做合并判定（合并在 M2b）。

1. **yaml 全局规则**：读 `~/.claude/team-hub/policy.yaml`，解析成 `{ global_allow, global_deny }`
2. **模板白名单（DB 注入）**：通过 `readTemplateWhitelist(instanceId)` 拿模板级 allow（可能为 `null`）
3. **热加载**：`fs.watch(configPath)` 变更 → 重读 yaml + 刷缓存
4. **容错**：yaml 解析失败 → log warn，保留上次快照（别让错配置炸整个 bus）
5. **生命周期**：`close()` 关闭 watcher

**接口签名**

```ts
export interface GlobalRules {
  allow: string[];
  deny: string[];
}

export interface RuleLoader {
  /** 当前 yaml 快照（同步，内存） */
  getGlobalRules(): GlobalRules;

  /** 读某 instanceId 的模板 allow（注入函数直通，不加额外缓存） */
  getTemplateAllow(instanceId: string): string[] | null;

  /** 关闭 fs.watch（进程 shutdown 用） */
  close(): void;
}

export interface RuleLoaderOptions {
  configPath?: string;              // 默认 ~/.claude/team-hub/policy.yaml
  watch?: boolean;                   // 默认 true，测试里可关
  readTemplateWhitelist?: (instanceId: string) => string[] | null;  // 注入式读 DB
}

export function createRuleLoader(opts?: RuleLoaderOptions): RuleLoader;
```

**key 口径**：参数统一叫 `instanceId`（与 Stage 3 `driverId === instanceId` 一致，见 M7 说明）。Loader 不做翻译，原样透传给注入函数。

**测试点（≥ 7 条）**

- 读不存在的 yaml → 返回空规则，不抛
- 读合法 yaml → `global_allow` / `global_deny` 正确解析
- yaml 格式错误 → 保留上次快照 + 不抛
- `fs.watch` 触发后缓存刷新（可用 fs 写 + 手动重载）
- `getTemplateAllow` 透传注入函数（返回 `null` / 返回 `string[]` 两种）
- 未注入 `readTemplateWhitelist` → `getTemplateAllow` 恒返 `null`
- `close()` 后 watcher 被关

**依赖**：
- 不 mock fs：单测真读真写 tmp 文件
- 不 mock DB：通过 `readTemplateWhitelist` 注入假函数

**交付物**

- [ ] `rule-loader.ts` ≤ 120 行
- [ ] `rule-loader.test.ts` ≥ 7 条 case 全绿
- [ ] `README.md` 续写"yaml 示例 + 热加载行为 + close 时机"

---

### M2b · policy/rule-merger

| 项目 | 值 |
|------|-----|
| 负责人 | dev (S5-M2b) |
| 状态 | 🟢 done |
| 类型 | 非业务（纯函数） |
| 文件 | `packages/backend/src/policy/rule-merger.ts` |
| 单测 | `packages/backend/src/policy/rule-merger.test.ts` |
| README | 续写 `packages/backend/src/policy/README.md` |
| 代码上限 | 60 行 |

**职责**

把 M2a 拿到的两级数据合并成调用方可用的 `EffectiveRules`。纯函数，不触碰 IO。

合并规则：
- 有效 allow = 模板 allow ∪ 全局 allow
- 有效 deny = 全局 deny（模板不设 deny）
- 模板 whitelist 为 `null` → `configured=false`（调用方按 default allow 处理）
- 模板 whitelist 为 `[]` → `configured=true`（调用方按显式空白名单处理：全部拒绝）

**接口签名**

```ts
import type { GlobalRules } from './rule-loader.js';

export interface EffectiveRules {
  allow: string[];
  deny: string[];
  configured: boolean;   // false = 该 instance 未配置任何模板白名单
}

/**
 * 合并模板 allow 和全局规则。
 * @param templateAllow - M2a 返回的 null | string[]
 * @param global        - M2a 返回的 GlobalRules
 */
export function mergeRules(
  templateAllow: string[] | null,
  global: GlobalRules,
): EffectiveRules;
```

**测试点（≥ 6 条）**

- `templateAllow=null` + 有全局 → `configured=false`，allow=全局 allow，deny=全局 deny
- `templateAllow=[]` + 有全局 → `configured=true`，allow=全局 allow，deny=全局 deny
- `templateAllow=['Bash']` + 全局 allow=['Read'] → allow=['Bash','Read']（去重）
- 模板 allow 和全局 allow 有重复 → 合集去重
- 全局为空 → allow=templateAllow / deny=[]
- 空入参（null + 空全局）→ `configured=false`, allow=[], deny=[]

**依赖**：零。纯函数。

**交付物**

- [x] `rule-merger.ts` ≤ 60 行（实际 48 行）
- [x] `rule-merger.test.ts` ≥ 6 条 case 全绿（实际 8 条 / 8 pass）
- [x] `README.md` 续写"两级合并规则 + configured 语义"

---

### M3 · bus/subscribers/container-registry

| 项目 | 值 |
|------|-----|
| 负责人 | _待派_ |
| 状态 | 🟡 pending |
| 类型 | 非业务（纯内存映射） |
| 文件 | `packages/backend/src/bus/subscribers/container-registry.ts` |
| 单测 | `packages/backend/src/bus/subscribers/container-registry.test.ts` |
| README | `packages/backend/src/bus/subscribers/CONTAINER-README.md`（M3 建，M4/M6 续写） |
| 代码上限 | 80 行 |

**职责**

维护 `agentId → { handle, runtime }` 的内存映射。封装注册 / 查询 / 移除 / 全量快照四个方法。

**接口签名**

```ts
// 接口以 docs/phase-sandbox-acp/INTERFACE-CONTRACTS.md §1/§2 为准
import type { ProcessRuntime, RuntimeHandle } from '../../process-runtime/types.js';

export interface ContainerEntry {
  handle: RuntimeHandle;
  runtime: ProcessRuntime;
  runtimeKind: 'host' | 'docker';
}

export interface ContainerRegistry {
  register(agentId: string, entry: ContainerEntry): void;
  get(agentId: string): ContainerEntry | null;
  remove(agentId: string): void;
  list(): ReadonlyArray<{ agentId: string; entry: ContainerEntry }>;
  size(): number;
}

export function createContainerRegistry(): ContainerRegistry;
```

**设计约束**

- 仅内存，无持久化
- 重复 register 同 agentId → 覆盖前先 warn（表示上层状态机有 bug）
- 不订阅任何 bus 事件（这是纯数据结构，订阅由 container.subscriber 做）

**测试点（≥ 5 条）**

- register + get 往返
- remove 后 get 返 null
- 重复 register 覆盖 + warn（用 spy console.warn）
- list 快照不会因后续变更漏/多
- size 正确

**依赖**：
- `process-runtime/types.ts`（Stage 1 已交付）— 只 import 类型，不 import 实现

**交付物**

- [ ] `container-registry.ts` ≤ 80 行
- [ ] `container-registry.test.ts` ≥ 5 条
- [ ] `CONTAINER-README.md` 里写 "registry 角色 + API"

---

### M4 · bus/subscribers/container-restart-policy

| 项目 | 值 |
|------|-----|
| 负责人 | _待派_ |
| 状态 | 🟡 pending |
| 类型 | 非业务（纯函数 + 最小状态桶） |
| 文件 | `packages/backend/src/bus/subscribers/container-restart-policy.ts` |
| 单测 | `packages/backend/src/bus/subscribers/container-restart-policy.test.ts` |
| README | 续写 `CONTAINER-README.md` |
| 代码上限 | 80 行 |

**职责**

1. 维护 `agentId → { count }` 重启计数
2. 根据第 N 次崩溃算退避毫秒数（指数：`base * 2^(n-1)`）
3. 判断是否超过 `maxRestarts` 应放弃

> **原设计**有 `createDriverInstanceMap()`，给 policy.subscriber 反查 `driverId → instanceId`。
> **已删**：P1-8 钉死 `driverKey === instanceId === event.driverId`，M7 不再需要反查。本模块只保留重启计数逻辑。

**接口签名**

```ts
export interface RestartPolicyConfig {
  maxRestarts: number;        // 默认 3
  backoffBaseMs: number;      // 默认 1000
}

export interface RestartDecision {
  action: 'restart' | 'give_up';
  delayMs: number;            // give_up 时 = 0
  attempt: number;            // 当前是第几次（从 1 起算）
}

export interface RestartPolicy {
  onCrash(agentId: string): RestartDecision;
  reset(agentId: string): void;
  peek(agentId: string): number;   // 当前已用次数，测试用
}

export function createRestartPolicy(cfg?: Partial<RestartPolicyConfig>): RestartPolicy;
```

**退避公式（钉死）**

- 第 1 次：`delay = base * 2^0 = 1000ms`
- 第 2 次：`delay = base * 2^1 = 2000ms`
- 第 3 次：`delay = base * 2^2 = 4000ms`
- 第 4 次：`action=give_up, delay=0`（当 max=3）

**测试点（≥ 6 条）**

- 第 1/2/3 次崩溃 attempt + delay 正确
- 第 4 次返回 give_up
- reset 后计数清零
- max=0 时第一次就 give_up（边界）
- 不同 agentId 计数互相隔离
- peek 返回当前次数

**依赖**：零。纯数据结构。

**交付物**

- [ ] `container-restart-policy.ts` ≤ 80 行
- [ ] `container-restart-policy.test.ts` ≥ 6 条
- [ ] `CONTAINER-README.md` 续写"重启策略公式"

---

## Wave 2 — 业务模块（Wave 1 全绿才启）

### M5 · bus/types.ts 扩事件类型

| 项目 | 值 |
|------|-----|
| 负责人 | _待派_ |
| 状态 | 🟡 pending |
| 类型 | 业务（但只改类型声明，先行） |
| 文件 | `packages/backend/src/bus/types.ts` |
| 单测 | 无（纯类型，跟 Stage 3/4 惯例一致） |
| 代码上限 | 追加 ≤ 50 行 |

**改动**

1. `BusEventType` 联合加 3 项：`container.started` / `container.exited` / `container.crashed`
2. 新增 3 个 interface（字段见 `stage-5-security.md` §5.2，一个字段都不要改）
3. `BusEvent` 联合加 3 项

**取消 `policy.violated`（重要）**

- Stage 5 之前设计有 `policy.violated` 作为中间事件：policy.subscriber emit → 另一订阅者读到后 emit `instance.offline_requested`。
- **去掉这一跳**：policy.subscriber 违规判定后**直接** emit `instance.offline_requested(requestedBy='policy-enforcer')`。审计走 `log.subscriber` 订阅 `instance.offline_requested` 读 `requestedBy` 即可。
- 原因：双事件链有时序风险（两订阅者之间无排序保证，且易被第三方订阅者截胡）。直接单跳更清晰。
- 因此 M5 只加 3 个事件，不新增 `policy.violated`。

**验收**

- [ ] `tsc --noEmit` 零错误
- [ ] `events.ts` 里的 `on<T>()` 对新事件有类型窄化（手测：`bus.on('container.crashed')` IDE 能提示 `exitCode`）

**特别约束**

- 字段名/类型必须与 `stage-5-security.md` §5.2 完全一致（driverId/agentId/runtimeKind/containerId/exitCode/reason/signal/cliType 字面量值）
- **不要同时改其它事件**。M5 的 diff 纯增量。

---

### M6 · bus/subscribers/container.subscriber

| 项目 | 值 |
|------|-----|
| 负责人 | s5-m6-dev |
| 状态 | 🟢 done |
| 类型 | 业务（胶水） |
| 文件 | `packages/backend/src/bus/subscribers/container.subscriber.ts` |
| 单测 | `packages/backend/src/bus/subscribers/container.subscriber.test.ts` |
| README | 续写 `CONTAINER-README.md`（**必含时序图 + 竞态分析**） |
| 代码上限 | 100 行 |

**职责**

编排容器生命周期三件事（接口参见 [`INTERFACE-CONTRACTS.md`](../INTERFACE-CONTRACTS.md) §1/§2）：
1. `primary_agent.started` → 读配置选 runtime → 组装 `LaunchSpec`（必带 `runtime: 'host' | 'docker'`） → `runtime.spawn(spec)` → 注册 registry → emit `container.started`
2. `handle.onExit((code, signal) => ...)` code≠0 且非用户主动 → emit `container.crashed` → 走重启策略（`onExit` 只允许注册一次）
3. `primary_agent.stopped` → `handle.kill()`（契约保证 SIGTERM → 2s → SIGKILL，幂等） → 清 registry → emit `container.exited(reason=stop_requested)`

**接口签名**

```ts
export interface ContainerSubscriberDeps {
  registry: ContainerRegistry;
  restartPolicy: RestartPolicy;
  readRuntimeConfig: (agentId: string) => {
    runtime: 'host' | 'docker';
    command: string;
    args: string[];
    env: Record<string, string>;
    dockerOptions?: Record<string, unknown>;
    hostOptions?: Record<string, unknown>;
  };
  buildRuntime: (kind: 'host' | 'docker', opts: unknown) => ProcessRuntime; // 便于测试注入
}

export interface ContainerSubscriberConfig {
  enabled: boolean;
  transport: 'http' | 'stdio';
  restartPolicy?: { maxRestarts: number; backoffBaseMs: number };
}

export function subscribeContainer(
  config: ContainerSubscriberConfig,
  deps: ContainerSubscriberDeps,
  eventBus?: EventBus,   // 默认 defaultBus
): Subscription;
```

**为什么用 DI**

- `registry` / `restartPolicy` / `buildRuntime` 全部外部注入，便于单测用假实现取代真 DockerRuntime；保持"非业务模块是真实依赖，业务模块串真实非业务模块"的测试纪律
- `readRuntimeConfig` 注入避免 subscriber 直接依赖 primary-agent DAO（解耦）

**时序（README 里画成 ASCII）**

```
primary_agent.started
   │
   ▼
 readRuntimeConfig(agentId)
   │
   ▼
 buildRuntime(kind) → runtime.spawn(LaunchSpec) ──► RuntimeHandle
   │                                             │
   ▼                                             ▼
 registry.register                          handle.onExit((code,sig)=>…)
   │                                             │
   ▼                                             ▼
 emit container.started                    if exitCode !== 0 && !userStopped
                                             → emit container.crashed
                                                  │
                                                  ▼
                                           restartPolicy.onCrash(agentId)
                                                  │
                                         ┌────────┴───────┐
                                         ▼                ▼
                                  action=restart     action=give_up
                                  setTimeout(delay) → emit container.exited
                                  re-emit primary_agent.started
```

**竞态要点（README 必写）**

1. 同一 agentId 重复 `primary_agent.started` → 先查 registry，已注册则跳过（否则会起两个进程）
2. `handle.onExit` 和 `primary_agent.stopped` 可能几乎同时触发：stopped 路径先 registry.remove 设 "userStopped=true" 再 kill，`handle.onExit` 回调读这个标记后不 emit crashed
3. 重启 `setTimeout` 期间又收到 stopped：取消 timer + 不再 emit primary_agent.started
4. 重启策略计数不持久化：backend 进程重启后计数清零（**已定的妥协**，README 写明）

**测试点（≥ 8 条）**

- host runtime 路径：emit primary_agent.started → 断言 registry 有记录 + container.started
- docker runtime 路径：同上换 runtime 字符串
- 崩溃 1/2/3 次：真 emit 非零 exit → 断言 crashed 事件 + 指数退避后再收到 primary_agent.started
- 第 4 次崩溃：断言 container.exited(reason=max_restart_exceeded)
- primary_agent.stopped：断言 kill + container.exited(reason=stop_requested) + registry 清理
- 重启 setTimeout 期间收到 stopped → timer 不触发
- config.enabled=false 时（测试只用 enabled=true，false 路径由 M8 覆盖）— **本测试不测 enabled=false**
- sandbox.enabled 默认不测（M8 覆盖）

**测试注意（mnemo 红线）**

- 不 mock EventBus，用真 `defaultBus` 或新建一个真 bus 实例
- 不 mock DB：`readRuntimeConfig` 注入式，测试直接传假函数即可（这是"注入假实现"，不是 mock 真依赖）
- runtime 用 M1 风格：测试里写一个 `FakeRuntime implements ProcessRuntime`，不 mock dockerode
- 时间用 vi.useFakeTimers / bun test fake timers

**交付物**

- [x] `container.subscriber.ts` 98 行（≤ 100）
- [x] `container.subscriber.test.ts` 11 条 / 11 pass（≥ 8）
- [x] `CONTAINER-README.md` 收尾：时序图 + 4 条竞态分析 + 错误传播路径 + FakeRuntime fixture

---

### M7 · bus/subscribers/policy.subscriber

| 项目 | 值 |
|------|-----|
| 负责人 | _待派_ |
| 状态 | 🟡 pending |
| 类型 | 业务（胶水） |
| 文件 | `packages/backend/src/bus/subscribers/policy.subscriber.ts` |
| 单测 | `packages/backend/src/bus/subscribers/policy.subscriber.test.ts` |
| README | `packages/backend/src/bus/subscribers/POLICY-README.md`（**必含时序图**） |
| 代码上限 | 80 行 |

**职责**

1. 订阅 `driver.tool_call`：
   - 从 event 读 `driverId`（= instanceId，见下方口径）
   - `global = loader.getGlobalRules()`；`tmpl = loader.getTemplateAllow(driverId)`
   - `rules = mergeRules(tmpl, global)`
   - `configured=false` → **放行**（default allow，未配置白名单的 instance 不拦截）
   - `configured=true` → `evaluate(toolName, rules)`：
     - `verdict='deny'` → **违规**（`reason='explicit_deny'`）
     - `verdict='no_match'` → **违规**（`reason='not_in_whitelist'`，已配置白名单但未命中）
     - `verdict='allow'` → 放行
   - **违规直接** emit `instance.offline_requested(instanceId=driverId, requestedBy='policy-enforcer', reason, correlationId)`
2. **不** emit `policy.violated`（该事件已从 M5 取消，见说明）
3. **不** 订阅 `driver.started` / `driver.stopped`（不再需要 driver→instance map，见口径说明）

**driverKey 口径（钉死）**

- `driverKey === instanceId === event.driverId`（与 Stage 2/3 的 `driverId === instanceId` 一致）
- 因此 policy.subscriber **直接用** `event.driverId` 当作 loader 的查询 key，不再需要 `resolveDriverKey` 注入
- 也不再需要 `DriverInstanceMap` 做反查：违规时直接 emit `instance.offline_requested(instanceId=event.driverId, ...)`
- 原 M4 里的 `DriverInstanceMap` 已移除（Stage 5 内无消费者，见 M4）

**接口签名**

```ts
import type { RuleLoader } from '../../policy/rule-loader.js';

export interface PolicySubscriberDeps {
  ruleLoader: RuleLoader;       // M2a
  // 注：不再有 driverMap / resolveDriverKey
}

export interface PolicySubscriberConfig {
  enabled: boolean;
  configPath?: string;
}

export function subscribePolicy(
  config: PolicySubscriberConfig,
  deps: PolicySubscriberDeps,
  eventBus?: EventBus,
): Subscription;
```

**审计链路**

- 不再用 `policy.violated` 做中间事件。审计通过 `log.subscriber` 订阅 `instance.offline_requested`，读 `requestedBy === 'policy-enforcer'` 的记录即可识别"策略强制下线"。
- 违规原因通过 `reason` 字段透传（`'explicit_deny'` / `'not_in_whitelist'`）。

**测试点（≥ 7 条）**

- driver.tool_call 命中 allow → 无任何下游事件
- driver.tool_call 命中 deny → emit `instance.offline_requested(requestedBy='policy-enforcer', reason='explicit_deny')`
- driver.tool_call 未命中 + configured=true → emit `instance.offline_requested(requestedBy='policy-enforcer', reason='not_in_whitelist')`
- driver.tool_call 未命中 + configured=false → 无下游事件（default allow）
- `instance.offline_requested.instanceId === event.driverId`（口径验证）
- correlationId 透传：`tool_call.correlationId` → `instance.offline_requested.correlationId`
- config.enabled=false → 不注册订阅（emit tool_call 后完全静默）

**交付物**

- [ ] `policy.subscriber.ts` ≤ 80 行（简化后变短）
- [ ] `policy.subscriber.test.ts` ≥ 7 条
- [ ] `POLICY-README.md`：时序图（单跳）+ driverKey===instanceId 口径说明 + correlationId 透传说明 + 审计链路说明

---

### M8 · bootSubscribers + server.ts 接入

| 项目 | 值 |
|------|-----|
| 负责人 | _待派_ |
| 状态 | 🟡 pending |
| 类型 | 业务（配置入口） |
| 文件 | `packages/backend/src/bus/index.ts`、`packages/backend/src/server.ts`、`packages/backend/src/bus/subscribers/ws.subscriber.ts` |
| 单测 | `packages/backend/src/bus/index.test.ts`（新建） |
| 代码上限 | index.ts 追加 ≤ 60 行；server.ts 改动 ≤ 30 行；ws 改 3 行 |

**改动项**

1. `bus/index.ts`
   - 导出 `SubscriberConfig` 接口（见 `stage-5-security.md` §4.1）
   - `bootSubscribers(deps, config: SubscriberConfig = {})`
   - `config.sandbox?.enabled` → `subscribeContainer(...)` with `restartPolicy` 默认补齐
   - `config.policy?.enabled` → `subscribePolicy(...)`
   - 内部构造 registry / restartPolicy / ruleLoader 单例，传入 subscriber（不再有 driverMap / ruleRepo）
   - `teardownSubscribers()` 加 `ruleLoader.close()`

2. `server.ts`
   - 接环境变量开关：`TEAM_HUB_SANDBOX=1` / `TEAM_HUB_POLICY=1`
   - 传给 `bootSubscribers`

3. `ws.subscriber.ts`
   - `WS_EVENT_TYPES` 集合加 `container.started` / `container.exited` / `container.crashed`（3 个）
   - **不加** `policy.violated`（该事件已取消，见 M5/M7）。`instance.offline_requested` 已在现有白名单中（Stage 3/4），无需改动

**单元测试（index.test.ts，≥ 6 条）**

- 不传 config → 只注册现有 subscribers（数量同 Stage 4），无 container / policy
- `sandbox.enabled=false` → 不注册 container.subscriber（观察事件流：emit primary_agent.started 后无 container.started）
- `sandbox.enabled=true` → 注册（emit primary_agent.started 后能看到 container.started）
- `policy.enabled=false` → 不拦截 tool_call
- `policy.enabled=true` → 拦截生效
- 重复调用 `bootSubscribers` 幂等
- `teardownSubscribers` 后 ruleLoader.close 被调用

**测试注意**

- 不 mock bus：测试 subscriber 是否注册，就是真 emit 真听
- container.subscriber 真跑需要 FakeRuntime 注入 — 可以把 M6 的 FakeRuntime 放到 `packages/backend/src/bus/subscribers/__test-fixtures__/fake-runtime.ts` 供 M8 复用

**交付物**

- [ ] `bus/index.ts` 改造完成
- [ ] `SubscriberConfig` 类型完整
- [ ] `server.ts` 接好环境变量
- [ ] `ws.subscriber.ts` 3 个事件纳入白名单（`container.started/.exited/.crashed`）
- [ ] `bus/index.test.ts` ≥ 6 条
- [ ] **不回归**：现有 301 个单测全绿

---

## 文件清单总览

```
packages/backend/src/
├── policy/
│   ├── rule-matcher.ts                      ← M1 新建
│   ├── rule-matcher.test.ts                 ← M1 新建
│   ├── rule-loader.ts                        ← M2a 新建
│   ├── rule-loader.test.ts                   ← M2a 新建
│   ├── rule-merger.ts                        ← M2b 新建
│   ├── rule-merger.test.ts                   ← M2b 新建
│   └── README.md                             ← M1 建 + M2a/M2b 续
├── bus/
│   ├── types.ts                              ← M5 追加 3 事件
│   ├── index.ts                              ← M8 改造
│   ├── index.test.ts                         ← M8 新建
│   └── subscribers/
│       ├── container-registry.ts             ← M3 新建
│       ├── container-registry.test.ts        ← M3 新建
│       ├── container-restart-policy.ts       ← M4 新建
│       ├── container-restart-policy.test.ts  ← M4 新建
│       ├── container.subscriber.ts           ← M6 新建
│       ├── container.subscriber.test.ts      ← M6 新建
│       ├── policy.subscriber.ts              ← M7 新建
│       ├── policy.subscriber.test.ts         ← M7 新建
│       ├── ws.subscriber.ts                  ← M8 改 3 行
│       ├── CONTAINER-README.md               ← M3 建，M4/M6 续写
│       ├── POLICY-README.md                  ← M7 新建
│       └── __test-fixtures__/
│           └── fake-runtime.ts               ← M6 建，M8 复用
└── server.ts                                 ← M8 接环境变量
```

---

## 验收门槛（所有模块共用）

每个模块开发者提交前自检：

- [ ] 单文件 ≤ 约定上限
- [ ] README.md 存在且 ≥ 30 行（非业务）/ ≥ 60 行（业务含时序图）
- [ ] `*.test.ts` 存在，case 数达标
- [ ] 无 mock DB / bus / router（mnemo 红线）
- [ ] `tsc --noEmit` 零错误
- [ ] `bun test` 本模块单测全绿
- [ ] 完成后更新本文件对应模块的"状态"列

---

## 状态跟踪

| 模块 | 状态 | 负责人 | 完成时间 |
|------|------|--------|---------|
| M1 rule-matcher | 🟢 done | developer | 2026-04-25 |
| M2a rule-loader | 🟢 done | dev-m2a | 2026-04-25 |
| M2b rule-merger | 🟢 done | dev | 2026-04-25 |
| M3 container-registry | 🟡 pending | — | — |
| M4 restart-policy | 🟢 done | dev-s5m8 (顺带) | 2026-04-25 |
| M5 bus/types 扩 | 🟢 done | developer | 2026-04-25 |
| M6 container.subscriber | 🟢 done | s5-m6-dev | 2026-04-25 |
| M7 policy.subscriber | 🟢 done | dev-s5m7 | 2026-04-25 |
| M8 bootSubscribers + server | 🟢 done | dev-s5m8 | 2026-04-25 |

图例：🟡 pending · 🔵 in_progress · 🟢 done · 🔴 blocked

---

## 架构师备注

1. **driverKey 口径钉死**：`driverKey === instanceId === event.driverId`（与 Stage 2/3 的 `driverId === instanceId` 一致）。M7 **不** 通过 `DriverInstanceMap` 反查、**不** 接收 `resolveDriverKey` 注入；rule-loader 直接用 `event.driverId` 作为 key 查模板白名单。原 M4 里的 `DriverInstanceMap` 已移除（Stage 5 内无消费者），M4 只保留重启计数。
2. **取消 `policy.violated` 中间事件**：违规判定后 policy.subscriber **直接** emit `instance.offline_requested(requestedBy='policy-enforcer', reason=...)`，不再走"policy.violated → 另一订阅者 → offline"的两跳链路（消除时序风险）。审计通过 `log.subscriber` 订阅 `instance.offline_requested` 读 `requestedBy` 实现。M5 只加 3 个新事件（`container.started/.exited/.crashed`）。
3. **restart 计数不持久化**：backend 重启后归零，这是 stage-5-security.md §2.1.2 已定的妥协，**不要**在 Stage 5 范围内做持久化（越界）。
4. **policy 是事后拦截**：`driver.tool_call` 在 ACP agent 侧已经发起，Stage 5 做"事后强制下线"而非阻止调用。这是 stage-5-security.md §3.1 已明文说明的边界，**不要**尝试改 AgentDriver 做事前拦截（那是新 Stage）。
5. **不 mock 底线**：Stage 5 允许 mock 的只有 `dockerode`（M6 间接通过 FakeRuntime 绕开）和时间 `setTimeout`（bun fake timers）。DB / bus / router / fs → 用真的。
