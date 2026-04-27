# Stage 5 — 安全策略 + 测试收尾

> **定位**：Sandbox + ACP 改造的最后一阶段。把容器生命周期、工具调用策略、全量测试补齐，让前四个 Stage 落下的能力形成闭环。
>
> **依赖**：
> - Stage 1 的 `process-runtime` 抽象（`HostRuntime` / `DockerRuntime` 两个实现 + 统一 `ProcessHandle` 契约）
> - Stage 2 的 `AgentDriver` 解耦（driver 只消费 `ProcessHandle`，不关心进程怎么起的）
> - Stage 3 的成员 ACP 迁移（`driver.*` 事件已是成员 Agent 的唯一输出通道）
> - Stage 4 的内置 MCP HTTP 化 + DockerRuntime（容器内主 Agent 通过 HTTP 反连宿主 MCP）

---

## 1. 目标

Stage 5 要把三件事收尾掉：

1. **容器生命周期管理** — 主 Agent 既可以跑在宿主（`HostRuntime`），也可以跑在容器（`DockerRuntime`）。容器模式下需要有人管"谁来启、崩了怎么办、退出怎么清理"，这件事单独抽成 `container.subscriber`。
2. **工具调用白名单** — 成员 Agent 迁到 ACP 之后，所有工具调用都经 `driver.tool_call` 事件流过 bus。Stage 5 在 bus 上挂一个 `policy.subscriber`，对违规调用做"拦截 + 强制下线"。
3. **全量测试收尾** — 前四个 Stage 各自补了本地单测，Stage 5 要把 subscriber 级、组件级、端到端三层测试打通，把整条改造链路的验收条件钉死。

设计原则延续 bus 架构的惯例：

- **subscriber 单一职责**：容器归容器，策略归策略，不交叉
- **配置驱动**：`bootSubscribers(deps, config)` 的第二参数决定哪些 subscriber 启用；`sandbox.enabled=false` 时容器/策略两个 subscriber 完全不注册，等同回退到 Stage 3 的纯 host 形态
- **事件驱动副作用**：容器崩溃、策略违规都走 bus 事件而非直接函数调用，保留审计和可观察性
- **< 100 行原则**：两个新 subscriber 各自控制在 100 行以内，复杂逻辑下沉到独立模块（runtime / policy-rule）

---

## 2. container.subscriber 设计

### 2.1 订阅事件

#### 2.1.1 `primary_agent.started` — 根据配置选 runtime

**触发来源**：`primaryAgent.start()` 成功后由 `primary-agent` 模块 emit（Stage 4 已有事件，只是之前没人真用）。

**处理逻辑**：

```ts
eventBus.on('primary_agent.started').subscribe(async (e) => {
  const cfg = primaryAgentRepo.getRuntimeConfig(e.agentId);
  // cfg.runtime: 'host' | 'docker'  —— 由面板配置页写入 primary_agent 表
  const runtime = cfg.runtime === 'docker'
    ? new DockerRuntime(cfg.dockerOptions)    // Stage 4 交付的实现
    : new HostRuntime(cfg.hostOptions);       // Stage 1 交付的实现

  const handle = await runtime.start({
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
  });

  containerRegistry.register(e.agentId, handle, runtime);  // 记住 agentId → handle 映射

  eventBus.emit({
    ...makeBase('container.started', 'bus/container.subscriber', e.correlationId),
    agentId: e.agentId,
    runtimeKind: cfg.runtime,
    containerId: handle.id,
  });
});
```

**关键决策**：
- `primary_agent.started` 语义是"API/面板已批准启动"，真正的"进程/容器拉起来"由 container.subscriber 完成。这样"配置变更不落地"不会污染 primary_agent 模块。
- `HostRuntime` 情况下 `handle.id` 就是 PID；`DockerRuntime` 下是 container ID。上层只看抽象，不区分。

#### 2.1.2 `container.crashed` — 重启策略

**触发来源**：`ProcessHandle.on('exit')` 中 exit code !== 0 && exit 非用户主动时，由 container.subscriber 自己发 `container.crashed`（不是第三方 emit）。

**重启策略**：最多 3 次，指数退避（1s / 2s / 4s）。超过 3 次后发 `container.exited` + 放弃。

```ts
eventBus.on('container.crashed').subscribe(async (e) => {
  const state = restartState.get(e.agentId) ?? { count: 0 };
  if (state.count >= 3) {
    eventBus.emit({
      ...makeBase('container.exited', 'bus/container.subscriber'),
      agentId: e.agentId,
      reason: 'max_restart_exceeded',
      exitCode: e.exitCode,
    });
    restartState.delete(e.agentId);
    return;
  }
  const delay = 1000 * Math.pow(2, state.count);
  state.count += 1;
  restartState.set(e.agentId, state);
  setTimeout(() => {
    eventBus.emit({
      ...makeBase('primary_agent.started', 'bus/container.subscriber'),
      agentId: e.agentId,
      cliType: e.cliType,
    });
  }, delay);
});
```

**为什么用 `primary_agent.started` 复用而非新事件**：保持单一入口，重启 = 重新走一遍启动路径。计数放 subscriber 内存里，进程重启后计数清零（可接受 — 重启后状态本来就是新的）。

#### 2.1.3 主动下线清理

```ts
eventBus.on('primary_agent.stopped').subscribe(async (e) => {
  const reg = containerRegistry.get(e.agentId);
  if (!reg) return;
  await reg.handle.kill('SIGTERM');
  containerRegistry.remove(e.agentId);
  restartState.delete(e.agentId);
  eventBus.emit({
    ...makeBase('container.exited', 'bus/container.subscriber'),
    agentId: e.agentId,
    reason: 'stop_requested',
    exitCode: 0,
  });
});
```

### 2.2 发出事件

| 事件                 | 语义                                                 |
| -------------------- | ---------------------------------------------------- |
| `container.started`  | 容器/进程成功拉起，handle 注册完毕                   |
| `container.exited`   | 容器正常退出（主动 stop / 超过重启上限 / 用户终止）  |
| `container.crashed`  | 非零退出码 + 非用户主动 = 崩溃，触发重启策略评估     |

### 2.3 文件结构

```
bus/subscribers/container.subscriber.ts           # < 100 行，三个 subscription
bus/subscribers/container-registry.ts             # agentId → {handle, runtime} 的内存映射
bus/subscribers/container-restart-policy.ts       # 重启计数、退避计算（纯函数便于单测）
```

**拆分原因**：subscriber 本身保持订阅 + 分派的薄壳形态，业务逻辑放 helper。这样单测不用起整条 bus 就能验证"第 4 次崩溃应该放弃"。

---

## 3. policy.subscriber 设计

### 3.1 订阅 `driver.tool_call`

```ts
eventBus.on('driver.tool_call').subscribe((e) => {
  const whitelist = policyRuleRepo.getWhitelistFor(e.driverId);
  if (whitelist === null) return;               // 不配置白名单 = 放行所有（default allow）
  if (whitelist.includes(e.name)) return;       // 命中白名单 = 放行

  // 违规：拦截
  eventBus.emit({
    ...makeBase('policy.violated', 'bus/policy.subscriber', e.correlationId),
    driverId: e.driverId,
    toolName: e.name,
    reason: 'not_in_whitelist',
  });
});
```

**注意**：`driver.tool_call` 是"ACP agent 声明要调用工具"的事件，bus 拦截点在工具真正执行**之前**还是**之后**由 Stage 2 的 AgentDriver 决定 — 从 Stage 2 文档看，`driver.tool_call` 是 ACP `ToolCallUpdate` 的直接映射，属于"工具已经在 agent 侧被调起"。因此 Stage 5 的策略层做的是**事后强制下线**（下一段），而不是"阻止调用发生"。如果后续需要**事前拦截**，需要在 AgentDriver 里把工具调用先挂起 → 查 policy → 再放行，属于 Stage 5 范围外的 AgentDriver 能力增强。

### 3.2 `policy.violated` → 触发 `instance.offline_requested`

```ts
eventBus.on('policy.violated').subscribe((e) => {
  const instanceId = driverToInstance.get(e.driverId);
  if (!instanceId) return;
  eventBus.emit({
    ...makeBase('instance.offline_requested', 'bus/policy.subscriber', e.correlationId),
    instanceId,
    requestedBy: 'policy-enforcer',
  });
});
```

**为什么两步走**：第一步 emit `policy.violated` 留审计痕迹；第二步把"违规 → 下线"的因果关系暴露在 bus 上，log.subscriber 自然带审计，WS 订阅者可实时推前端红点。

**driverId → instanceId 映射**：Stage 3 的成员 ACP 迁移里，AgentDriver 每个成员一个，driverId 通常就是 instanceId。但主 Agent 的 driverId 跟 agentId 不同。policy.subscriber 维护一个映射表（`driver.started` 时写入，`driver.stopped` 时清理）。

### 3.3 白名单配置来源

两级合并：

1. **模板级** — `primary_agent` 表 + `role_templates` 表新增 `tool_whitelist: TEXT (JSON array)` 列
2. **运行时策略文件** — `~/.claude/team-hub/policy.yaml`，进程启动时 watch，变更热加载

**合并规则**：模板白名单 ∪ 全局放行白名单 = 有效白名单；`null` 表示不配置（default allow）。

```yaml
# ~/.claude/team-hub/policy.yaml
global_allow:
  - mcp__mteam__*      # team-hub 自己的工具全放行
deny:
  - Bash               # 即使模板声明允许，这里显式拒绝也会覆盖
```

**deny 优先级 > allow**：全局 deny 是安全底线，模板不能绕过。

### 3.4 文件结构

```
bus/subscribers/policy.subscriber.ts              # < 100 行
policy/rule-repo.ts                                # 读 DB + 解析 yaml + 合并白名单
policy/rule-matcher.ts                             # 通配符匹配（纯函数）
```

---

## 4. bootSubscribers 配置驱动

### 4.1 新签名

```ts
// bus/index.ts
export interface SubscriberConfig {
  sandbox?: {
    enabled: boolean;                    // 关掉就等同 Stage 3 的纯 host 形态
    transport: 'http' | 'stdio';         // 内置 MCP 的连接方式（Stage 4）
    restartPolicy?: {
      maxRestarts: number;               // 默认 3
      backoffBaseMs: number;             // 默认 1000
    };
  };
  policy?: {
    enabled: boolean;                    // 关掉 = default allow
    configPath?: string;                 // 策略 yaml 路径，默认 ~/.claude/team-hub/policy.yaml
  };
}

export function bootSubscribers(
  deps: { commRouter: CommRouter },
  config: SubscriberConfig = {},
): void {
  if (masterSub) return;
  masterSub = new Subscription();
  masterSub.add(subscribeRoster());
  masterSub.add(subscribeTeam());
  masterSub.add(subscribePty());
  masterSub.add(subscribeDomainSync());
  masterSub.add(subscribeCommNotify(deps.commRouter));
  masterSub.add(subscribeLog());

  if (config.sandbox?.enabled) {
    masterSub.add(subscribeContainer(config.sandbox));
  }
  if (config.policy?.enabled) {
    masterSub.add(subscribePolicy(config.policy));
  }
  wsBroadcaster.start();
}
```

### 4.2 server.ts 集成

```ts
// server.ts
bootSubscribers(
  { commRouter: comm.router },
  {
    sandbox: {
      enabled: process.env.TEAM_HUB_SANDBOX === '1',
      transport: (process.env.TEAM_HUB_MCP_TRANSPORT as 'http' | 'stdio') ?? 'stdio',
    },
    policy: {
      enabled: process.env.TEAM_HUB_POLICY === '1',
    },
  },
);
```

**默认行为**：环境变量都不设 = Stage 3 形态，完全向后兼容。

### 4.3 为什么不放进 helpers/DI 容器

bus 当前架构就是"subscribers 是模块级函数，靠模块单例共享状态"。引入 DI 容器会打破这条约定。配置直传是最小侵入的做法。

---

## 5. 新增事件类型

### 5.1 `BusEventType` 新增项

```ts
// bus/types.ts
export type BusEventType =
  | /* 原有事件略 */
  | 'container.started'
  | 'container.exited'
  | 'container.crashed'
  | 'policy.violated';
```

### 5.2 事件定义

```ts
export interface ContainerStartedEvent extends BusEventBase {
  type: 'container.started';
  agentId: string;
  runtimeKind: 'host' | 'docker';
  containerId: string;                   // HostRuntime 下 = String(pid)
}

export interface ContainerExitedEvent extends BusEventBase {
  type: 'container.exited';
  agentId: string;
  reason: 'stop_requested' | 'max_restart_exceeded' | 'normal_exit';
  exitCode: number | null;
}

export interface ContainerCrashedEvent extends BusEventBase {
  type: 'container.crashed';
  agentId: string;
  cliType: string;                        // 透传给重启事件
  exitCode: number;                       // 非零
  signal: number | null;
}

export interface PolicyViolatedEvent extends BusEventBase {
  type: 'policy.violated';
  driverId: string;
  toolName: string;
  reason: 'not_in_whitelist' | 'explicit_deny';
}
```

### 5.3 WS 白名单更新

`ws.subscriber.ts` 的 `WS_EVENT_TYPES` 集合加入这 4 个新事件，前端可实时收到"容器崩溃"和"策略违规"。

---

## 6. 全量测试计划

### 6.1 单元测试（`bun:test`）

| 文件                                           | 覆盖范围                                                       |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `process-runtime-host.test.ts`                 | `HostRuntime.start/kill/on('exit')` 契约 — 跑真子进程          |
| `process-runtime-docker.test.ts`               | `DockerRuntime` — dockerode mock，验证调用参数/状态机          |
| `agent-driver.test.ts` *(已存在，扩展)*        | 注入 mock `ProcessHandle`，验证 ACP 握手/事件映射              |
| `container-subscriber.test.ts`                 | emit `primary_agent.started` → 验证 runtime 选择与事件派发     |
| `container-restart-policy.test.ts`             | 纯函数：第 N 次崩溃的退避时间、达到上限后的退出事件            |
| `policy-subscriber.test.ts`                    | emit `driver.tool_call` → 验证命中/违规分支 + 下线触发         |
| `policy-rule-matcher.test.ts`                  | 通配符 `mcp__mteam__*` / 精确匹配 / deny 覆盖 allow            |

**Mock 约束**：严禁 mock DB、bus、EventBus（沿用"不 mock 测试"红线）。只 mock 外部 SDK（dockerode）和时间（`setTimeout`）。

### 6.2 集成测试

| 场景                         | 做法                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| 内置 MCP HTTP 链路           | 起 mteam MCP HTTP server → curl 调 `/search_members` → 断言响应 + log.subscriber 收到事件   |
| 成员 ACP 端到端              | `POST /api/role-instances` → AgentDriver 握手 → bus 有 `driver.turn_done` → HTTP 查 roster  |
| container.subscriber 真实重启 | fake CLI 命令启 → kill -9 → 验证 `container.crashed` → 指数退避后自动 `container.started`   |
| policy 违规级联下线          | 手动 emit `driver.tool_call{name:'ForbiddenTool'}` → 断言 instance 状态变 PENDING_OFFLINE   |

**放置位置**：`packages/backend/src/__tests__/integration-*.test.ts`。按 Stage 3 / Stage 4 已有的 `http-*.test.ts` / `team-integration.test.ts` 风格组织。

### 6.3 端到端测试

两条关键链路各跑一次，结果落 `docs/phase-sandbox-acp/e2e-report.md`：

**E2E-1：主 Agent 容器模式**
```
1. 面板配置 primary_agent.runtime = docker
2. POST /api/primary-agent/start
3. 观察 bus 事件序列：
   primary_agent.started → container.started(runtimeKind=docker)
                        → driver.started → driver.turn_done
4. 主 Agent 在容器内调用 mteam MCP（HTTP 反连宿主）
5. 验证 search_members 结果 + DB 中 tool_call 审计记录
6. docker kill 容器 → 观察 container.crashed → 1s 后自动重启
```

**E2E-2：成员 Agent host 模式**
```
1. POST /api/role-instances { templateName, memberName }
2. 成员 AgentDriver 启动（HostRuntime，stdio ACP）
3. POST /api/role-instances/:id/activate
4. 给成员发一条 comm 消息 → 成员回复 → 触发 driver.tool_call
5. 策略放行 MCP 工具，拒绝 Bash → 观察 policy.violated → instance 下线
6. 验证 role_instances.status = DELETED + roster 清理
```

---

## 7. 验收 Checklist

最终交付必须全部打勾：

**代码完整性**
- [ ] `bus/types.ts` 4 个新事件类型已添加，`BusEvent` 联合类型已扩展
- [ ] `bus/subscribers/container.subscriber.ts` < 100 行，三个订阅全量覆盖 started / crashed / stopped
- [ ] `bus/subscribers/policy.subscriber.ts` < 100 行，包含 driverId→instanceId 映射维护
- [ ] `bootSubscribers` 接受第二参数 `SubscriberConfig`，`sandbox.enabled=false` 时不注册新 subscriber
- [ ] `ws.subscriber.ts` 的 `WS_EVENT_TYPES` 集合加入 4 个新事件
- [ ] `policy/rule-repo.ts` 实现 yaml 热加载 + 模板白名单合并

**质量门槛**
- [ ] `bun test` 全绿，新增单测覆盖率 ≥ 80%（runtime/subscriber/matcher 三个目录）
- [ ] 不存在对 DB / bus / router 的 mock（mnemo 红线）
- [ ] 每个新模块自带单测文件
- [ ] `tsc --noEmit` 零错误

**行为验证**
- [ ] E2E-1 主 Agent 容器模式通过，含崩溃自愈
- [ ] E2E-2 成员 Agent 策略拦截通过
- [ ] Stage 3 的 host 形态功能未回归（跑完整 `http-*.test.ts` 测试套件）

**文档收尾**
- [ ] `docs/phase-sandbox-acp/MILESTONE.md` 更新 Stage 5 状态为 DONE
- [ ] `docs/phase-sandbox-acp/e2e-report.md` 两条链路结果记录

---

## 8. 架构图

### 8.1 subscriber 在 bus 上的位置

```
                              ┌──────────────────────────────┐
                              │        EventBus (RxJS)       │
                              │  subject: Subject<BusEvent>  │
                              └──────────────────────────────┘
                                          │
            ┌────────────────┬────────────┼────────────┬────────────────┬─────────────────┐
            ▼                ▼            ▼            ▼                ▼                 ▼
      ┌──────────┐     ┌─────────┐   ┌────────┐   ┌────────┐   ┌───────────────┐   ┌──────────────┐
      │  roster  │     │   pty   │   │  team  │   │   ws   │   │   container   │   │    policy    │
      │ .subscr. │     │.subscr. │   │.subscr.│   │.subscr.│   │   .subscr.    │   │   .subscr.   │  ← Stage 5 新增
      └──────────┘     └─────────┘   └────────┘   └────────┘   └───────────────┘   └──────────────┘
           │                │            │            │                │                   │
           ▼                ▼            ▼            ▼                ▼                   ▼
      roster DAO      ptyManager      team DAO    WebSocket      containerReg         policyRuleRepo
                                                                  + runtime            (DB + yaml)
                                                                    ↓
                                                          HostRuntime / DockerRuntime
```

### 8.2 容器生命周期事件流

```
  [面板/API]                  [primary-agent]              [container.subscriber]
      │                             │                              │
  start ──► POST /start ───emit──► primary_agent.started ──subs──► start runtime
                                                                   │
                                                                   └─emit──► container.started
                                                                                 │
                                                                                 ▼
                                                                            [ws.subscriber] → 前端
      ...
  （运行中进程/容器 crash）
                                   ProcessHandle.on('exit', code!==0)
                                          │
                                          └──emit container.crashed──► [container.subscriber]
                                                                              │
                                                                              ├─ count < 3 →  指数退避 → emit primary_agent.started (重走流程)
                                                                              └─ count ≥ 3 →  emit container.exited(max_restart_exceeded)
```

### 8.3 策略拦截事件流

```
  [AgentDriver]                   [policy.subscriber]                  [cascadeOfflineMember]
       │                                   │                                    │
  ACP tool_call ──emit──► driver.tool_call ┤
                                           │
                                           ├─ whitelist 命中 → 放行（不做事）
                                           │
                                           └─ 违规 ─emit──► policy.violated ──subs──► emit instance.offline_requested
                                                              │                               │
                                                              ▼                               ▼
                                                       [log.subscriber] 审计        [team.subscriber]
                                                                                    cascadeOfflineMember →
                                                                                    requestOffline / forceDelete
```

### 8.4 配置开关决定拓扑

```
  bootSubscribers(deps, config)
  │
  ├── roster / pty / team / domain-sync / comm-notify / log / ws   ← 永远注册（Stage 3 以前就有）
  │
  ├── sandbox.enabled = true?
  │       └── subscribeContainer(sandbox)                          ← Stage 5 按需
  │
  └── policy.enabled = true?
          └── subscribePolicy(policy)                              ← Stage 5 按需

  关闭 sandbox + policy：行为等同 Stage 3 纯 host 模式，零运行时开销。
```

---

## 附：与前四 Stage 的依赖边界

| Stage | Stage 5 用到的东西                                                |
| ----- | ------------------------------------------------------------------ |
| 1     | `ProcessHandle` 契约 / `HostRuntime` 实现                          |
| 2     | `AgentDriver` 只消费 handle，Stage 5 替换 runtime 零侵入 driver    |
| 3     | 成员的 `driver.tool_call` 事件流；`cascadeOfflineMember` 级联下线  |
| 4     | `DockerRuntime` 实现 + 内置 MCP HTTP server                        |

Stage 5 自身不引入新运行时能力，只做**编排**与**策略**。审视本文件时若发现引入了 runtime 抽象之外的进程管理逻辑，属于**越界**，应回退到 Stage 1/4 处理。
