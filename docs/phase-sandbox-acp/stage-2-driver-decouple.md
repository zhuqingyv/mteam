# Stage 2 — AgentDriver 解耦

> 前置：Stage 1 已落地 `process-runtime` 抽象层（`RuntimeHandle` / `HostRuntime` / `LaunchSpec`）。
> 本阶段把 `AgentDriver` 从"既管生命周期又管 spawn"的耦合态改成"只管 ACP 协议"的纯协议层。

> **[修订注 · 2026-04-25]** 本文档下文示意代码中出现的 `handle.stdio.{stdin,stdout}`（§4.1）、`handle.exit$`（§4.2）、§8.1 `MockRuntimeHandle` 的 `stdio` / `exit$` 字段，**均与冻结签名不一致**。以 [`INTERFACE-CONTRACTS.md`](./INTERFACE-CONTRACTS.md) §1 为准：
> - `stdin` / `stdout` 是 `RuntimeHandle` 的顶层字段（非 `handle.stdio.*`）。
> - 没有 `exit$` Observable；退出事件通过 `handle.onExit(cb)` 单次注册，消费侧需要 Observable 时自行 `fromEvent`/`Subject` 包装。
> - 没有 `stderr` 字段。
> - `LaunchSpec` 必填 `runtime: 'host' | 'docker'` 字段（本文档 §4.4 的简化版示意少了此字段，以契约为准）。
>
> 实现者按契约签名编码；以下示意代码仅说明"语义映射"，**字段名以契约为准**。

## 1. 目标

- **AgentDriver 不再负责 spawn 子进程**，只持有一个 `RuntimeHandle`（stdin/stdout/exit 事件的统一抽象），
  在其之上跑 ACP 协议握手、`session/new`、`prompt`。
- **进程创建权外移**：由调用方（PrimaryAgent / 成员编排层）决定在哪种 `RuntimeHandle` 上跑 driver——
  本地 `HostRuntime`、容器 `DockerRuntime`、还是测试用的 `MockRuntime`，driver 一概不知也不关心。
- **事件输出解耦 bus**：driver 不再硬编码 `emitToBus`，改为暴露 `events$: Observable<DriverEvent>`，
  是否、何时、如何进 bus 由上层决定。
- **adapter 职责收窄**：`prepareSpawn` 改名为 `prepareLaunch`，返回的 `LaunchSpec` 给 runtime 层消费，
  adapter 不再暗含"要被 `child_process.spawn` 喂"的前提。

结果：driver 变成纯协议适配器，可以在任何能提供 stdio 的运行时上跑；bus-bridge 从 driver 内部剥离，
成为可选的、幂等的"DriverEvent → BusEvent"翻译器。

## 2. 当前耦合分析

代码位置：`packages/backend/src/agent-driver/driver.ts`（下文行号均指向此文件）。

### 2.1 耦合点 A —— 直接 `spawn()` 子进程（L79-L94）

```ts
// driver.ts:79-94
private async bringUp(): Promise<void> {
  const spec = this.adapter.prepareSpawn(this.config);
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  this.child = child;
  child.once('exit', (code, signal) => { ... });
```

**为什么是问题**
- `spawn` 是 `node:child_process` 的本地能力，driver 直接依赖 → 后续要跑 Docker / 远端沙箱时，
  必须在 driver 里加 `if (runtime === 'docker')` 分支，破坏单一职责。
- `stdio: ['pipe', 'pipe', 'inherit']` 的具体策略属于"本机进程"的实现细节，容器/远端不适用。
- `exit` 事件回调和 `kill()` 调用（L132-L138）也都是 `ChildProcess` API，锁死了运行时形态。

### 2.2 耦合点 B —— 把 Node Stream 手动转 WebStream 喂给 ACP SDK（L96-L98）

```ts
// driver.ts:96-98
const input = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>;
const output = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(input, output);
```

**为什么是问题**
- `child.stdin` / `child.stdout` 是 `ChildProcess` 字段，driver 必须知道子进程长什么样才能取到 stdio。
- 运行时变成 Docker 或 WebSocket 时，stdio 不再是 Node Stream，这段强转就无法复用。
- 该转换属于"运行时适配"，不是 driver 的协议职责。

### 2.3 耦合点 C —— 事件硬编码 `emitToBus`（L141-L143 + L12）

```ts
// driver.ts:12
import { emitToBus, type DriverBusEvent } from './bus-bridge.js';
// driver.ts:141-143
private dispatch(ev: DriverBusEvent): void {
  emitToBus(this.id, ev);
}
```

**为什么是问题**
- driver 的每个事件都直接进全局 bus，测试时无法隔离（跑一次测试就污染全局事件流）。
- 上层只能"订阅全局 bus、按 driverId 过滤"（见 `primary-agent.ts:120-131`），
  多 driver 并存时所有订阅者都会被唤醒，再自行过滤掉 N-1 条事件，显而易见的浪费。
- driver 和 bus 的耦合让"单独启动一个 driver 做协议调试"变得不可能——必须带着整条 bus 链路。

### 2.4 耦合点 D —— `adapter.prepareSpawn()` 假设了本机 spawn（L80 + adapter.ts:8）

```ts
// adapter.ts:6-8
export interface AgentAdapter {
  prepareSpawn(config: DriverConfig): SpawnSpec;
```

```ts
// claude.ts:9-19
prepareSpawn(config: DriverConfig): SpawnSpec {
  return {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
    cwd: config.cwd,
  };
}
```

**为什么是问题**
- `SpawnSpec`（types.ts:26-31）字段名、语义都绑定 `child_process.spawn`，暗示"一定是本机进程"。
- `...process.env` 直接把宿主环境变量合并进来，容器化后这层污染不能带过去。
- `cwd` 字段本意是"在哪跑"，但 `DockerRuntime` 的"cwd"语义是容器内路径，不是宿主路径，
  命名不中立会误导后续实现。

### 2.5 耦合点 E —— `teardown()` 直接操作 `ChildProcess`（L126-L139）

```ts
// driver.ts:132-138
if (c && !c.killed) {
  c.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } resolve(); }, 2000);
    c.once('exit', () => { clearTimeout(t); resolve(); });
  });
}
```

**为什么是问题**
- "SIGTERM → 2s → SIGKILL"是本机进程语义，Docker 对应的是 `docker stop -t 2 && docker kill`，
  应该归 runtime 层实现。
- driver 不该决定"2 秒后升级信号"这种运行时策略。

## 3. 解耦后的 AgentDriver 接口

### 3.1 新接口形态

```ts
// packages/backend/src/agent-driver/driver.ts（改造后）
import type { Observable } from 'rxjs';
import { Subject } from 'rxjs';
import * as acp from '@agentclientprotocol/sdk';
import type { DriverConfig, DriverStatus, DriverEvent } from './types.js';
import type { RuntimeHandle } from '../process-runtime/types.js';
import type { AgentAdapter } from './adapters/adapter.js';

export type DriverLifecycleEvent =
  | { type: 'driver.started' }
  | { type: 'driver.stopped' }
  | { type: 'driver.error'; message: string };

export type DriverOutputEvent = DriverEvent | DriverLifecycleEvent;

export class AgentDriver {
  readonly id: string;
  readonly config: DriverConfig;
  status: DriverStatus = 'IDLE';

  readonly events$: Observable<DriverOutputEvent>;

  constructor(
    id: string,
    config: DriverConfig,
    handle: RuntimeHandle,                 // ← 外部注入
    adapter?: AgentAdapter,                // ← 可注入，方便测试
  );

  isReady(): boolean;
  async start(): Promise<void>;            // 只跑 ACP 握手 + session/new
  async prompt(message: string): Promise<void>;
  async stop(): Promise<void>;             // 只关协议，不杀进程（进程由 handle 负责）
}
```

**关键变化**
- 构造函数多一个 `handle: RuntimeHandle` 参数；driver 自己不再 `spawn`。
- 新增 `events$: Observable<DriverOutputEvent>`，内部用 `Subject` 推；bus 订阅是上层可选行为。
- `stop()` 只做协议层关闭（取消订阅、清 sessionId、调 adapter.cleanup），进程由 `handle.kill()` 负责，
  但 driver 可以在 stop 时**可选**调用 `handle.kill()`——取决于语义约定（见 §4.3）。

### 3.2 改造前 vs 改造后

```
┌─────────────────────── 改造前 ───────────────────────┐
│                                                      │
│    PrimaryAgent                                      │
│        │                                             │
│        │ new AgentDriver(id, config)                 │
│        ▼                                             │
│    ┌────────────────────────────────────────┐        │
│    │ AgentDriver                            │        │
│    │  ├─ adapter.prepareSpawn()             │        │
│    │  ├─ child_process.spawn()  ← 本机进程  │        │
│    │  ├─ Readable/Writable.toWeb            │        │
│    │  ├─ acp.ndJsonStream()                 │        │
│    │  ├─ acp.ClientSideConnection           │        │
│    │  ├─ session/new                        │        │
│    │  ├─ prompt / turn                      │        │
│    │  ├─ child.kill() × SIGTERM/SIGKILL     │        │
│    │  └─ emitToBus()  ← 硬编码全局 bus      │        │
│    └────────────────────────────────────────┘        │
│                    │                                 │
│                    ▼                                 │
│                 全局 bus (所有订阅者)                │
│                                                      │
└──────────────────────────────────────────────────────┘

┌─────────────────────── 改造后 ───────────────────────┐
│                                                      │
│    PrimaryAgent                                      │
│        │                                             │
│        │ 1. spec = adapter.prepareLaunch(config)     │
│        │ 2. handle = await runtime.spawn(spec)       │
│        │ 3. driver = new AgentDriver(id, cfg, handle)│
│        │ 4. subscribe driver.events$ → bus           │
│        ▼                                             │
│    ┌────────────────────────────────────────┐        │
│    │ AgentDriver (纯协议层)                 │        │
│    │  ├─ 持有 RuntimeHandle (只读接口)      │        │
│    │  ├─ acp.ndJsonStream(handle.stdio)     │        │
│    │  ├─ acp.ClientSideConnection           │        │
│    │  ├─ session/new + prompt               │        │
│    │  └─ events$: Subject<DriverEvent>      │        │
│    └────────────────────────────────────────┘        │
│                    │ events$                         │
│                    ▼                                 │
│            bus-bridge (订阅方自选)                   │
│                    │                                 │
│                    ▼                                 │
│                 全局 bus                             │
│                                                      │
│    RuntimeHandle 由 HostRuntime / DockerRuntime /    │
│    MockRuntime 实现，driver 完全无感知。             │
│                                                      │
└──────────────────────────────────────────────────────┘
```

## 4. spawn 逻辑迁移路径

目标：把 `driver.ts:79-94, 126-139` 里的本机进程管理代码整体迁进 Stage 1 的 `HostRuntime.spawn()`。
以下按步骤列出怎么搬。

### 4.1 `bringUp()` 开头（L80-L85）→ `HostRuntime.spawn(spec)`

```ts
// 当前（driver.ts:80-85）：
const spec = this.adapter.prepareSpawn(this.config);
const child = spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  env: spec.env,
  stdio: ['pipe', 'pipe', 'inherit'],
});
```

搬到 `packages/backend/src/process-runtime/host-runtime.ts`：

```ts
// HostRuntime.spawn() 内部（由 Stage 1 落地）
async spawn(spec: LaunchSpec): Promise<RuntimeHandle> {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return new HostRuntimeHandle(child);
}
```

driver.ts 改造后的 `bringUp()`（示意）：

```ts
private async bringUp(): Promise<void> {
  // spec 由调用方构建好后通过 handle 注入；driver 不再感知 spec。
  const { stdin, stdout } = this.handle.stdio;
  const stream = acp.ndJsonStream(stdin, stdout);
  // ... ACP 协议部分保留（L100-L123）
}
```

### 4.2 `exit` 事件监听（L87-L94）→ `RuntimeHandle.onExit` 回调

```ts
// 当前（driver.ts:87-94）：
child.once('exit', (code, signal) => {
  if (this.status === 'STOPPED') return;
  this.status = 'STOPPED';
  this.dispatch({
    type: 'driver.error',
    message: `child exited (code=${code}, signal=${signal})`,
  });
});
```

改造为订阅 `handle.exit$`（Stage 1 的 `RuntimeHandle` 要暴露）：

```ts
// driver.ts 改造后
this.exitSub = this.handle.exit$.subscribe(({ code, signal }) => {
  if (this.status === 'STOPPED') return;
  this.status = 'STOPPED';
  this.emit({
    type: 'driver.error',
    message: `runtime exited (code=${code}, signal=${signal})`,
  });
});
```

### 4.3 `teardown()` 杀进程段（L132-L138）→ `RuntimeHandle.kill()`

```ts
// 当前（driver.ts:132-138）：
if (c && !c.killed) {
  c.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} resolve(); }, 2000);
    c.once('exit', () => { clearTimeout(t); resolve(); });
  });
}
```

全部搬进 `HostRuntimeHandle.kill()`，driver.stop() 只保留协议层清理：

```ts
// driver.ts 改造后
async stop(): Promise<void> {
  if (this.status === 'STOPPED') return;
  try { this.adapter.cleanup(); } catch { /* */ }
  this.exitSub?.unsubscribe();
  this.conn = null;
  this.sessionId = null;
  // 进程终结的责任：
  //   - 调用方如果要 driver 同时杀进程，显式调 handle.kill() 或通过 driver.stop({ kill: true })
  //   - 默认不 kill（让 runtime 层决定），避免 driver 越权
  this.status = 'STOPPED';
  this.emit({ type: 'driver.stopped' });
}
```

**为什么默认不杀进程**：Docker 场景下"关会话不等于关容器"，容器可能要复用；本机 `HostRuntime` 里一个
handle 对应一个进程，关进程由调用方（PrimaryAgent）按生命周期决定。driver 只管协议。

### 4.4 `adapter.prepareSpawn` → `adapter.prepareLaunch`

```ts
// adapter.ts 改造后
export interface AgentAdapter {
  prepareLaunch(config: DriverConfig): LaunchSpec;   // ← 重命名 + 类型替换
  sessionParams(config: DriverConfig): Record<string, unknown>;
  parseUpdate(update: unknown): DriverEvent | null;
  cleanup(): void;
}
```

`LaunchSpec` 由 Stage 1 在 `process-runtime/types.ts` 定义，字段与原 `SpawnSpec` 接近但语义中立：

```ts
// process-runtime/types.ts (Stage 1)
export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  // 预留：容器镜像、资源限制等，由 DockerRuntime 消费
}
```

`claude.ts` / `codex.ts` 的 `prepareSpawn` 方法体几乎不用改，只改方法名和返回类型别名。

### 4.5 调用方改造（primary-agent.ts:75）

```ts
// 当前（primary-agent.ts:75）：
const driver = new AgentDriver(row.id, config);
```

改为：

```ts
// 改造后
const adapter = createAdapter(config);          // 从 driver.ts 导出
const spec = adapter.prepareLaunch(config);
const handle = await this.runtime.spawn(spec);  // runtime 从外部注入
const driver = new AgentDriver(row.id, config, handle, adapter);
```

`PrimaryAgent` 构造函数要多收一个 `runtime: Runtime` 依赖（默认 `hostRuntime` 单例），测试时可替换为 `MockRuntime`。

## 5. bus-bridge 改造

### 5.1 目标

- `emitToBus` **不再从 driver 内部调用**。
- driver 只对外暴露 `events$: Observable<DriverOutputEvent>`，纯内存事件流。
- bus-bridge 变成可选的"订阅适配器"：上层愿意接 bus 就订阅，不愿意（测试、headless 调试）就不订阅。

### 5.2 改造后的数据流

```
改造前：
┌──────────────┐   dispatch(ev)        ┌──────────────┐   emit         ┌──────────────┐
│  driver.ts   │─────────────────────▶│ bus-bridge   │───────────────▶│   bus        │
│              │   (硬编码)            │ emitToBus()  │                │ events$      │
└──────────────┘                       └──────────────┘                └──────┬───────┘
                                                                              │
                                                                              ▼
                                                                     所有订阅者收到
                                                                     (需按 driverId 过滤)

改造后：
┌──────────────┐   Subject.next(ev)    ┌──────────────────────────┐
│  driver.ts   │─────────────────────▶│ driver.events$           │
│              │                       │ (Observable<Event>)      │
└──────────────┘                       └────────┬─────────────────┘
                                                │
                     ┌──────────────────────────┼──────────────────────────┐
                     │                          │                          │
                     ▼                          ▼                          ▼
              ┌─────────────┐           ┌─────────────┐           ┌─────────────┐
              │ bus-bridge  │           │ 测试订阅者   │           │ 直接 stdout │
              │ (可选)      │           │ (ObserverSpy)│          │ (调试)      │
              └──────┬──────┘           └─────────────┘           └─────────────┘
                     │ attachToBus(driverId, events$)
                     ▼
              ┌─────────────┐
              │   bus       │
              │  events$    │
              └─────────────┘
```

### 5.3 bus-bridge.ts 新 API

```ts
// bus-bridge.ts 改造后
import type { Observable, Subscription } from 'rxjs';
import { bus } from '../bus/events.js';
import { makeBase } from '../bus/helpers.js';
import type { DriverOutputEvent } from './driver.js';

const SOURCE = 'agent-driver';

// 返回 Subscription，调用方负责在 driver 停止时 unsubscribe。
export function attachDriverToBus(
  driverId: string,
  events$: Observable<DriverOutputEvent>,
): Subscription {
  return events$.subscribe((ev) => translate(driverId, ev));
}

function translate(driverId: string, ev: DriverOutputEvent): void {
  // 原 emitToBus 的 switch 逻辑整体搬过来，一行不改。
}
```

### 5.4 PrimaryAgent 侧的订阅变化

```ts
// primary-agent.ts 改造前（L120-L131）：全局订阅 + 按 driverId 过滤
const sub = defaultBus.events$.subscribe((ev) => {
  if (ev.type === 'driver.error' && ev.driverId === agentId) { ... }
});

// 改造后：直接订阅 driver.events$，不用再过滤
const busSub = attachDriverToBus(agentId, this.driver.events$);
const logicSub = this.driver.events$.subscribe((ev) => {
  if (ev.type === 'driver.error') { void this.handleDriverFailure(agentId); }
  else if (ev.type === 'driver.stopped') { this.handleDriverStopped(agentId); }
});
this.driverSubs = [busSub, logicSub];
```

两点收益：
- 不再"全局广播 + 过滤"，避免多 driver 并存时的事件放大。
- 测试场景可以完全不调 `attachDriverToBus`，用 `firstValueFrom(driver.events$.pipe(filter(...)))`
  直接断言事件流，不污染全局 bus。

## 6. adapter 改造

### 6.1 改动清单

| 位置 | 改造前 | 改造后 |
| --- | --- | --- |
| `adapter.ts:8` | `prepareSpawn(config): SpawnSpec` | `prepareLaunch(config): LaunchSpec` |
| `types.ts:26-31` | 导出 `SpawnSpec` | 删除；改引用 `process-runtime/types.ts` 的 `LaunchSpec` |
| `claude.ts:9` | `prepareSpawn(config): SpawnSpec {` | `prepareLaunch(config): LaunchSpec {` |
| `codex.ts` | 同 claude.ts | 同 claude.ts |

### 6.2 保持不变的部分

- `sessionParams(config)` —— 纯协议参数，运行时无关，一行不动。
- `parseUpdate(update)` —— ACP SessionUpdate 的收窄逻辑，和进程怎么起没关系，一行不动。
- `cleanup()` —— adapter 自己的资源清理（如 Codex 可能写临时文件），和 runtime 无关。

### 6.3 为什么不把 adapter 也拆进 runtime 层

有过一版设想是让 runtime 直接吃 `AgentAdapter` 然后自己 spawn + 建协议连接，这样 driver 可以更薄。
**否决理由**：adapter 里的 `parseUpdate` / `sessionParams` 是 ACP 语义，runtime 层完全不懂 ACP，
硬塞进去就变成了"runtime 层知道 ACP"，污染抽象。保持 adapter 服务于 driver、runtime 只管进程，
边界更干净。

## 7. 改动文件清单

| 文件 | 改动类型 | 说明 |
| --- | --- | --- |
| `packages/backend/src/agent-driver/driver.ts` | 大改 | 删 `spawn` / `child` / `Readable.toWeb` / `emitToBus`；构造函数加 `handle`；内部 `Subject` + `events$`；`stop()` 只关协议 |
| `packages/backend/src/agent-driver/types.ts` | 中改 | 删 `SpawnSpec`（由 Stage 1 的 `LaunchSpec` 替代）；`DriverEvent` 保留；新增 `DriverLifecycleEvent` / `DriverOutputEvent` 类型或移到 `driver.ts` 导出 |
| `packages/backend/src/agent-driver/bus-bridge.ts` | 中改 | `emitToBus` 改名 `attachDriverToBus`，接收 `Observable` 而不是被 driver 主动调；翻译逻辑不变 |
| `packages/backend/src/agent-driver/adapters/adapter.ts` | 小改 | `prepareSpawn` → `prepareLaunch`，返回类型换成 `LaunchSpec` |
| `packages/backend/src/agent-driver/adapters/claude.ts` | 小改 | 方法名 + 返回类型跟进；实现体不变 |
| `packages/backend/src/agent-driver/adapters/codex.ts` | 小改 | 同上 |
| `packages/backend/src/primary-agent/primary-agent.ts` | 中改 | `start()`：构 `LaunchSpec` → `runtime.spawn` → `new AgentDriver(..., handle)`；`subscribeDriverEvents` 改订 `driver.events$`；构造函数加 `runtime` 依赖 |
| `packages/backend/src/agent-driver/__tests__/driver.test.ts` | 新增 | 见 §8 |

**不改的文件**（显式列出以免误伤）：
- `packages/backend/src/bus/events.ts` / `helpers.ts` —— bus 本身不动。
- `packages/backend/src/primary-agent/driver-config.ts` —— 配置构建逻辑不动。
- `packages/backend/src/primary-agent/repo.ts` —— DB 层不动。

## 8. 测试策略

核心思路：**AgentDriver 从此可用 `MockRuntimeHandle` 单测，不再需要真进程**。

### 8.1 MockRuntimeHandle（Stage 1 提供）

```ts
// Stage 1 的 process-runtime/mock-runtime.ts（示意）
export class MockRuntimeHandle implements RuntimeHandle {
  readonly stdio: { stdin: WritableStream; stdout: ReadableStream };
  readonly exit$: Observable<{ code: number | null; signal: string | null }>;

  // 测试辅助：手动推 ACP 响应进 stdout，断言 stdin 收到的请求
  pushStdout(line: string): void;
  readStdin(): Promise<string[]>;
  simulateExit(code: number, signal?: string): void;
  async kill(): Promise<void>;
}
```

### 8.2 driver.test.ts 用例骨架

```ts
// packages/backend/src/agent-driver/__tests__/driver.test.ts
describe('AgentDriver (纯协议测试，不起真进程)', () => {
  it('start() 走完 ACP initialize + session/new 后进入 READY', async () => {
    const mock = new MockRuntimeHandle();
    const driver = new AgentDriver('d1', minimalConfig, mock, new FakeAdapter());

    const startPromise = driver.start();
    // 模拟 child 回 initialize 响应
    await mock.expectRequest('initialize');
    mock.respond({ protocolVersion: acp.PROTOCOL_VERSION, ... });
    // 模拟 child 回 session/new 响应
    await mock.expectRequest('session/new');
    mock.respond({ sessionId: 'sess-1' });

    await startPromise;
    expect(driver.status).toBe('READY');
  });

  it('events$ 会按顺序发出 driver.started / driver.text / driver.turn_done', async () => {
    const events: DriverOutputEvent[] = [];
    const mock = new MockRuntimeHandle();
    const driver = new AgentDriver('d1', cfg, mock, new FakeAdapter());
    driver.events$.subscribe((ev) => events.push(ev));

    await bootstrap(driver, mock);                    // 握手 → READY
    const prompt = driver.prompt('hi');
    mock.pushSessionUpdate({ sessionUpdate: 'agent_message_chunk',
                             content: { type: 'text', text: 'hello' } });
    mock.respondPrompt({ stopReason: 'end_turn' });
    await prompt;

    expect(events.map((e) => e.type)).toEqual([
      'driver.started', 'driver.text', 'driver.turn_done',
    ]);
  });

  it('runtime exit 时 driver 进入 STOPPED 并发 driver.error', async () => {
    // ...
  });

  it('start 超时 (> 30s) 会 teardown 并抛错', async () => {
    // 用 fake timers + mock 永不回应
  });

  it('stop() 不 kill handle（责任在调用方）', async () => {
    // 断言 mock.kill 未被调用
  });
});
```

### 8.3 bus-bridge.test.ts 用例骨架

```ts
describe('attachDriverToBus', () => {
  it('把 DriverOutputEvent 翻译成对应 BusEvent', () => {
    const subject = new Subject<DriverOutputEvent>();
    const busSpy = spyOnBus();

    const sub = attachDriverToBus('d1', subject.asObservable());
    subject.next({ type: 'driver.text', content: 'hi' });
    subject.next({ type: 'driver.turn_done', stopReason: 'end_turn' });

    expect(busSpy.events).toMatchObject([
      { type: 'driver.text', driverId: 'd1', content: 'hi' },
      { type: 'driver.turn_done', driverId: 'd1' },
    ]);
    sub.unsubscribe();
  });
});
```

### 8.4 primary-agent 集成测试

用 `MockRuntime`（不是 `MockRuntimeHandle`）注入到 `PrimaryAgent`，覆盖：
- configure → start → prompt → stop 全流程
- runtime spawn 失败时 driver 不会被创建
- driver.error 事件触发 `handleDriverFailure` 并同步 DB 状态

### 8.5 不测什么

- **不在单测里起真 `npx @agentclientprotocol/claude-agent-acp`**——那是 e2e 的事，不是单测。
- **不测 `HostRuntime.spawn` 本身**——那是 Stage 1 的测试范围。
- **不测 ACP SDK 的协议正确性**——信任 `@agentclientprotocol/sdk`。

### 8.6 门槛

- driver.ts 单测覆盖率 ≥ 90%（纯协议层，理应高覆盖）。
- bus-bridge.ts 行覆盖率 100%（翻译逻辑穷举 case）。
- 不允许出现 `spawn`, `child_process`, `node-pty` 的 import 出现在 `agent-driver/` 目录下的任何文件里
  （可用 eslint `no-restricted-imports` 兜底）。
