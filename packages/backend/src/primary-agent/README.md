# primary-agent

总控 Agent 的生命周期胶水。串接：`ProcessRuntime` → `AgentAdapter` → `AgentDriver` → `bus-bridge` → EventBus + SQLite。

本模块**不**直接 spawn 进程，也不直接跑 ACP 协议：
- 起进程：注入的 `ProcessRuntime`（默认 `HostRuntime`）
- 跑 ACP：`AgentDriver`（构造时注入 `RuntimeHandle`）
- 推 bus：`attachDriverToBus(driverId, driver.events$)`
- DB 状态：本类自己调 `setStatus`

---

## 对外接口

```ts
class PrimaryAgent {
  constructor(eventBus?: EventBus, runtime?: ProcessRuntime);

  boot(): void;                                    // 进程启动时恢复上次配置
  teardown(): Promise<void>;                       // 进程退出时清理
  configure(cfg): Promise<PrimaryAgentRow>;        // UPSERT 配置 + 切 cliType 自动重启
  getConfig(): PrimaryAgentRow | null;
  start(): Promise<PrimaryAgentRow>;               // runtime.spawn → driver.start
  stop(): Promise<void>;                           // driver.stop → handle.kill
  isRunning(): boolean;
}

export const primaryAgent = new PrimaryAgent();    // 全局单例（服务端用）
```

构造参数：
- `eventBus`：默认全局 `bus`
- `runtime`：默认 `new HostRuntime()`；测试注入 `MockRuntime` 隔离

---

## 时序图：start() 流程

```
PrimaryAgent.start()
    │
    ├─ 1. readRow()                               // DB 读最近一次 configure
    ├─ 2. cliManager.isAvailable(row.cliType)     // 本地 CLI 校验，未装就抛
    ├─ 3. buildDriverConfig(row)                  // 展开 mcpConfig → McpServerSpec[]
    │
    ├─ 4. createAdapter(config)                   // 同步：选 Claude / Codex adapter
    ├─ 5. adapter.prepareLaunch(config)           // 同步：拼 LaunchSpec（runtime='host'）
    ├─ 6. mergeHostEnv(spec, config)              // 胶水补 process.env（host 模式）
    ├─ 7. runtime.spawn(spec)                     // 异步：起进程，拿 RuntimeHandle
    ├─ 8. new AgentDriver(id, config, handle, adapter)
    ├─ 9. subscribeDriverEvents(id)               // 同时挂：
    │     ├─ attachDriverToBus(id, events$)      //   └─ bus 翻译桥
    │     └─ events$.subscribe(logicHandler)     //   └─ 本地状态机
    ├─10. driver.start()                          // 异步：ACP handshake + session/new
    │   ├─ 成功 → setStatus RUNNING + emit primary_agent.started
    │   └─ 失败 → unsubscribe + handle.kill() + 抛错给外部
    │
    └─ 返回 row
```

关键约束：
- 第 7 步成功后，在第 8 步之前就写 `this.driverHandle = handle`。
  这样如果第 10 步失败前外部并发调 `stop()`，也能兜底 kill handle。
- 第 9 步在第 10 步之前订阅 events$。driver 在 `start()` 内 emit `driver.started`，
  晚订阅会错过事件。

---

## 时序图：stop() / 故障清理

```
stop()                               handleDriverFailure(agentId)          handleDriverStopped(agentId)
  │                                   ↑ driver.events$ emit driver.error    ↑ driver.events$ emit driver.stopped
  ├─ 读 driver + handle                │                                     │
  ├─ 清引用（置 null）                 └─ cleanupAfterDriverDeath(id, TRUE) └─ cleanupAfterDriverDeath(id, FALSE)
  ├─ driver.stop()（if any）                │                                     │
  ├─ handle.kill()（if any）                ├─ 清引用                             ├─ 清引用
  ├─ unsubscribeDriver()                    ├─ driver.stop()                     ├─ handle.kill() 幂等
  └─ setStatus + emit primary_agent.stopped ├─ handle.kill()                     ├─ unsubscribeDriver()
                                            ├─ unsubscribeDriver()               └─ setStatus + emit stopped
                                            └─ setStatus + emit stopped
```

清理顺序：**driver.stop → handle.kill → unsubscribe**。
- 先 `driver.stop()` 让 ACP 优雅收尾（发 `driver.stopped`），Observable 才会 complete；
  complete 之后 busSub / logicSub 会自然结束，unsubscribe 只是保险幂等。
- `handle.kill()` 由胶水负责，driver 本身不杀进程（INTERFACE-CONTRACTS §4.3）。
- 任何一步抛错都被 `try { ... } catch { /* ignore */ }` 吞掉，不阻塞后续清理。

---

## 竞态分析

| 场景 | 风险 | 解决 |
|------|------|------|
| `start()` 中 `runtime.spawn` 成功后、`driver.start()` 失败前 `stop()` 并发 | handle 已拿到但还没进 driver 状态 | 第 7 步后立即赋值 `this.driverHandle`；`stop()` 读 `driverHandle` 兜底 kill |
| driver 主动 emit `driver.error` + `driver.stopped`（两条相继） | 两次 handler 清理 | `cleanupAfterDriverDeath` 开头判 `if (!this.driver) return`，幂等 |
| 快速连发 `configure(cliChanged)` 两次 | stop 还没完 start 又被触发 | `configure` 内 `await this.stop(); await this.start();` 串行 |
| `runtime.spawn` 抛错 | 没 driver、也没 handle，外部只看 throw | `start()` 里不 catch spawn，自然抛给调用方；isRunning 仍为 false |
| `handleDriverStopped` 触发时 `handle.kill()` 已退出 | 重复 kill | `RuntimeHandle.kill` 幂等（HostRuntime/DockerRuntime 契约），no-op |

---

## 错误传播路径

```
runtime.spawn 失败
   └─> start() 直接 throw（未创建 driver）
       └─> configure 上层捕获 / boot 写 stderr

driver.start 失败（ACP 握手 / session/new 超时）
   └─> driver 内部 teardown → emit driver.error + driver.stopped
       │
       ├─ bus-bridge → bus.events$ 可见
       └─ primary-agent.handleDriverFailure
           └─> handle.kill() + setStatus STOPPED + emit primary_agent.stopped
       └─ start() catch 块 → handle.kill() + 抛错给外部（防护式双保险）

runtime 进程崩溃（子进程 SIGKILL / 异常 exit）
   └─> handle.onExit 触发
       └─> driver 内部 emit driver.error + driver.stopped
           └─> primary-agent.handleDriverStopped
               └─> handle.kill() 幂等（已退出 no-op）+ setStatus STOPPED
```

---

## MCP 产物装配（Stage 4 W2-B · `launch-spec-builder.ts`）

`buildDriverConfig()` 拿到 `mcpManager.resolve()` 的 `ResolvedMcpSet { specs, skipped }`
后，不直接手拼 `McpServerSpec[]`，而是委托 `buildMcpServerSpecs()` 统一分流：

| 输入 | runtime | 产出 `McpServerSpec` |
|---|---|---|
| `{ kind:'builtin', name:'mteam' }` | host | `transport:'http'`, `url: http://localhost:58591/mcp/mteam`, headers `X-Role-Instance-Id` / `X-Is-Leader` / `X-Tool-Visibility` |
| `{ kind:'builtin', name:'mteam' }` | docker | 同上但 host 换成 `host.docker.internal:58591` |
| `{ kind:'builtin', name:'searchTools' }` | host/docker | `transport:'http'`, url 同上规则；headers 仅 `X-Role-Instance-Id` |
| `{ kind:'user-stdio', ... }` | host/docker | `transport:'stdio'` 原样透传（Stage 5 再处理 docker volume） |

`runtimeKind` 来自 `BuildDriverConfigInput.runtimeKind`（缺省 `'host'`，Stage 5 `PrimaryAgentRow` 加字段后由 repo 读）。两个 HTTP base URL 分别走
`MCP_HTTP_BASE_HOST`（默认 `http://localhost:58591`）和 `MCP_HTTP_BASE_DOCKER`
（默认 `http://host.docker.internal:58591`）两个 env 变量，测试可覆盖。

**member-agent 共用同一个 builder**：`member-agent/driver-config.ts` 复用
`buildMcpServerSpecs()`，只是 `instanceId` 传的是成员实例 id，`isLeader=0`。原因：
删除 `MTEAM_MCP_ENTRY` 后 primary + member 两类 agent 的 stdio 链路都统一走 HTTP，
builder 是两边共同的分流点。

---

## env 合并决策

`AgentAdapter.prepareLaunch` 只透传 `config.env`（不感知 runtime 类型），这是刻意的：
adapter 产规格，不决定底层是 host 还是 docker。

但 host 进程启动需要 `process.env.PATH`（否则 `npx` 都找不到）。合并父进程 env
属于**业务决策**，放在胶水层：`mergeHostEnv(spec, config)` 仅在 `spec.runtime === 'host'`
时合并，docker 场景原样透传（docker 自有 env 语义，不能污染）。

合并顺序：`process.env` ← `config.env` ← `spec.env`（spec.env 优先级最高，支持
adapter 覆盖父进程变量）。

---

## 使用示例

```ts
// 默认全局单例
import { primaryAgent } from '../primary-agent/primary-agent.js';
await primaryAgent.configure({ name: 'Alpha', cliType: 'claude', systemPrompt: 'hi' });
await primaryAgent.start();
// ... 运行中
await primaryAgent.stop();

// 测试：注入 MockRuntime + 隔离 bus
import { EventBus } from '../bus/events.js';
const bus = new EventBus();
const runtime = new MockRuntime();
const agent = new PrimaryAgent(bus, runtime);
await agent.configure({ name: 't', cliType: 'claude' });
await agent.start();  // 自动用 MockRuntimeHandle，不起真进程
```
