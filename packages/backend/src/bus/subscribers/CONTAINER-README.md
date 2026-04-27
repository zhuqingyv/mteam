# Container Subscribers

Stage 5 沙箱化容器生命周期编排所需的订阅者 / 工具模块集合。

本目录与容器相关的模块：

- `container-registry.ts` — agentId → RuntimeHandle 内存映射（M3，本文档）
- `container-restart-policy.ts` — 崩溃重启计数 + 指数退避（M4，待补）
- `container.subscriber.ts` — 监听 `primary_agent.*` 编排 spawn/kill（M6，待补）

---

## M3 · container-registry

### 角色

维护 `agentId → { handle, runtime, runtimeKind }` 的内存映射，供 `container.subscriber` 在处理 `primary_agent.stopped` / `driver.tool_call` 等事件时快速反查当前运行中的 `RuntimeHandle`。

**非业务模块定位**：纯 Map 封装，不 import bus/db，不订阅任何事件。事件订阅与业务编排由 `container.subscriber`（M6）负责。

### API

```ts
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
  clear(): void;
}

export function createContainerRegistry(): ContainerRegistry;
```

### 使用示例

```ts
import { createContainerRegistry } from './container-registry.js';

const registry = createContainerRegistry();

// primary_agent.started 时
registry.register(agentId, { handle, runtime, runtimeKind: 'docker' });

// primary_agent.stopped 时
const current = registry.get(agentId);
if (current) {
  await current.handle.kill();
  registry.remove(agentId);
}
```

### 行为约定

- **仅内存，无持久化**：backend 进程重启后映射清空（Stage 5 已定的妥协）。
- **重复 register 覆盖 + warn**：同一 `agentId` 再次 register 视为上层状态机 bug，会先 `console.warn` 再覆盖原条目（便于测试 spy）。
- **`get` 返回 `null` 而非 `undefined`**：调用方用 `if (entry)` 判空即可，无需 `?.`。
- **`list()` 是快照**：返回后续修改不会影响已取快照。
- **不订阅 bus**：要监听 `primary_agent.*` 事件请用 `container.subscriber`（M6）。

### 不做的事

- 不维护 agent 状态机（started/stopped/crashed）— 那是 `container.subscriber` 的事
- 不做崩溃计数或重启节流 — 那是 `container-restart-policy`（M4）的事
- 不关心 `handle.onExit` 注册 — 调用方自行注册

---

## M6 · container.subscriber

### 角色

串接 M3（registry）+ M4（restart-policy）+ `process-runtime`（spawn/kill），把 `primary_agent.*` 事件翻译为容器生命周期动作，对外 emit `container.started` / `container.crashed` / `container.exited`。**业务胶水层**：承担事件编排、时序控制、错误传播、状态同步。

### API

```ts
export interface ContainerSubscriberConfig {
  enabled: boolean;
  transport?: 'http' | 'stdio';
}
export interface ContainerSubscriberDeps {
  registry: ContainerRegistry;
  restartPolicy: RestartPolicy;             // { onCrash, reset, peek }
  readRuntimeConfig: (agentId, cliType) => RuntimeConfigResolved;
  buildRuntime: (kind, opts) => ProcessRuntime;
}
export function subscribeContainer(
  config: ContainerSubscriberConfig,
  deps: ContainerSubscriberDeps,
  eventBus?: EventBus,
): Subscription;
```

所有外部依赖全部 DI，`buildRuntime` 允许测试用 FakeRuntime 绕开 `dockerode`。

### 时序图

```
primary_agent.started (agentId, cliType)
   │
   ▼
 registry.get(agentId) → 非空则 skip（去重，见竞态 C1）
   │
   ▼
 readRuntimeConfig(agentId, cliType) → { runtime, command, args, env, cwd, *Options }
   │
   ▼
 buildRuntime(runtime, *Options) → runtime.spawn(LaunchSpec) ──► RuntimeHandle
   │                                                            │
   ▼                                                            ▼
 registry.register                                      handle.onExit((code,sig)=>…)
   │                                                            │
   ▼                                                            ▼
 emit container.started                          life.userStopped?
                                                  │
                                        ┌─────────┴─────────┐
                                        ▼                   ▼
                                       true                false
                                   (stopped 路径已处理)       │
                                   静默退出                code===0?
                                                            │
                                                ┌───────────┴───────────┐
                                                ▼                       ▼
                                          reset + emit            emit container.crashed
                                          container.exited        │
                                          (normal_exit)           ▼
                                                            restartPolicy.onCrash(agentId)
                                                                  │
                                                        ┌─────────┴─────────┐
                                                        ▼                   ▼
                                                    restart             give_up
                                                        │                   │
                                                    setTimeout(delayMs)    emit container.exited
                                                        │                 (max_restart_exceeded)
                                                        ▼
                                                  emit primary_agent.started
                                                  （走回顶端的 start 路径）

primary_agent.stopped (agentId)
   │
   ▼
 life.userStopped = true；clear restartTimer（若有）
   │
   ▼
 registry.remove + restartPolicy.reset
   │
   ▼
 handle.kill()（契约保证 SIGTERM→2s→SIGKILL，幂等；onExit 回调会触发但被 userStopped 门禁挡住）
   │
   ▼
 emit container.exited(reason=stop_requested, exitCode=null)
```

### 竞态分析

- **C1 · 同 agentId 重复 `primary_agent.started`**：可能来自 replay、人肉重试、或重启 timer 与外部再次调用撞车。`start` 函数一开始就 `registry.get(agentId)` 非空即跳过，避免起两个进程。副作用：如果上一次的 handle 实际已挂但 `onExit` 回调还没触发，这次 started 会被错误 skip。缓解：崩溃路径先 `registry.remove` 再 emit crashed/exited，让任何后续 started 能拿到干净状态。
- **C2 · `handle.onExit` 与 `primary_agent.stopped` 几乎同时触发**：stopped 路径先把 `life.userStopped = true` 再 `handle.kill`，kill 引发 onExit 回调时检查 userStopped 门禁 → 不 emit crashed / 不走重启。stopped 自己独立 emit `container.exited(stop_requested)`。
- **C3 · 重启 `setTimeout` 期间收到 `primary_agent.stopped`**：stop 路径显式 `clearTimeout(life.restartTimer)`，定时器不会触发那次 `primary_agent.started` re-emit，避免"用户已停止但进程又被拉起"。
- **C4 · 重启计数不持久化**：backend 进程重启后 restart-policy 内存计数清零。属于 stage-5-security.md §2.1.2 已定的妥协，非竞态但会影响"本次进程能见到的 max"与"重启前的历史次数"，**不要**在本模块补持久化（越界）。

### 错误传播路径

| 故障点 | subscriber 反应 | 最终状态 |
|--------|----------------|---------|
| `runtime.spawn` 抛错 | stderr 写 `spawn failed`；**不** 注册 registry、**不** emit container.started | agent 处在 "started 事件已发出但无容器" 的悬空状态；上层需自行判断是否 re-emit。subscriber 不自动重试以避免无限循环（配置读不到 / 镜像不存在这类错误重试也无意义） |
| `handle.kill` 抛错（stopped 路径） | stderr 写 `kill failed`；仍然 emit `container.exited(stop_requested)` | registry 已清、状态机前进，避免 agent 卡在 "stop_requested 未回执" |
| `restartPolicy.onCrash` 抛错 | 不 try/catch（视为 M4 bug，让它沿 emit 栈冒到 EventBus.emit 的顶层 try/catch 被吞） | bus-level 日志打错，subscriber 状态保持；下一次 crash 会再试 |
| `onExit` 触发时 life 已被 `teardownSubscribers`（unsubscribe 清 map） | `life === undefined` 提前 return | 容器已被强制清理时不再干扰 |
| subscribe 时 `config.enabled=false` | 直接返回空 Subscription，不注册任何 handler | M8 启动配置未开启 → 行为与 Stage 4 完全一致，emit primary_agent.started 后无 container.* |

### 测试策略

- 真 `EventBus`（不 mock）
- 真 `createContainerRegistry()`（非业务，真依赖）
- 假 `RestartPolicy`：脚本化返回 `RestartDecision` 列表
- 假 `ProcessRuntime`：`__test-fixtures__/fake-runtime.ts` 提供 `FakeRuntime` + `FakeHandle.emitExit(code)` 让测试主动触发退出
- 时间：用真实 `setTimeout`，`delayMs` 设小值（5~30ms）+ `await tick(ms)` 推进
- 覆盖 case：host / docker 路径、重复 started 去重、崩溃重启 → 再 spawn、超限 give_up、stopped 路径 kill+清理、stopped 抢占重启 timer、正常退出 normal_exit、多 agent 隔离、spawn 抛错、enabled=false

### 设计决策记录

- **DI 全量注入**：registry/restartPolicy/buildRuntime 外部注入，便于测试绕开真 DockerRuntime，同时保持"业务模块消费真实非业务模块"的纪律
- **`readRuntimeConfig` 注入而非内部读 DAO**：避免 subscriber 直接依赖 `primary-agent` 表；M8 负责把 DAO 包装成这个函数传进来
- **重启 re-emit `primary_agent.started` 而非直接调 `start`**：统一入口，下游订阅者（例如 log）能观察到完整事件链，符合 event-sourced 原则
- **`signal` 字段固定 null**：M5 定义 `ContainerCrashedEvent.signal: number | null`，而 host runtime onExit 回调给的是 `string | null`（信号名），类型不对齐；暂填 null，等待 M5/M4 对齐字段含义后补。`exitCode` 字段正常透传
