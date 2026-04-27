# Stage 2 — 模块拆分清单

> 架构师产出 · 用于把 Stage 2（AgentDriver 解耦）拆成并行可交付的独立模块。
> 执行者先读 [WORKFLOW.md](../WORKFLOW.md)、[stage-2-driver-decouple.md](../stage-2-driver-decouple.md)。
> Stage 2 依赖 Stage 1 产出的 `RuntimeHandle` / `ProcessRuntime` / `LaunchSpec`（见
> [stage-1-process-runtime.md §2-§6](../stage-1-process-runtime.md)）。Stage 1 必须先完成 Wave 1。

---

## 0. 总览

```
Wave 1（非业务，三人并行）                    Wave 2（业务胶水，一人收口）
┌──────────────────────────┐
│ mod-adapter-launch        │ ──┐
│ (prepareSpawn→prepareLaunch│    │
│  SpawnSpec→LaunchSpec)    │    │
└──────────────────────────┘    │
                                 │
┌──────────────────────────┐    │       ┌────────────────────────────┐
│ mod-driver-decouple       │ ───┼──────▶│ glue-primary-agent          │
│ (注入 RuntimeHandle +     │    │       │ (runtime.spawn → new Driver │
│  events$ Subject)         │    │       │  → subscribe events$)      │
└──────────────────────────┘    │       └────────────────────────────┘
                                 │
┌──────────────────────────┐    │
│ mod-bus-bridge            │ ──┘
│ (emitToBus→attachDriverToBus│
│  订阅式翻译)              │
└──────────────────────────┘
```

**依赖说明**

- Wave 1 三个模块相互独立，只依赖：
  - Stage 1 的 `LaunchSpec` / `RuntimeHandle` 类型（从 `process-runtime/types.ts` import）
  - `@agentclientprotocol/sdk`、`rxjs`（已在 package.json）
- Wave 2 `glue-primary-agent` 依赖 Wave 1 全部三个模块的新接口。
- **Wave 1 全完才启 Wave 2**，不抢跑（WORKFLOW §6.8）。

---

## 1. Wave 1 — 非业务模块

### 1.1 mod-adapter-launch

| 字段 | 值 |
|------|----|
| 模块目录 | `packages/backend/src/agent-driver/adapters/`（原地改） |
| 负责人 | _待 leader 派单_ |
| 预估代码 | 改 ~30 行（3 个文件）+ 新增 0 文件 |
| 预估测试 | 追加 ~40 行（每个 adapter 一个 `prepareLaunch` 用例） |
| 依赖 | Stage 1 `LaunchSpec` 类型（`packages/backend/src/process-runtime/types.ts`） |
| 阻塞 | 无（纯重命名 + 类型替换，和 driver.ts 改造并行） |

**要做什么**

1. 把 `AgentAdapter` 接口的 `prepareSpawn(config): SpawnSpec` 改名为
   `prepareLaunch(config): LaunchSpec`（见 `adapter.ts:6-8`）。
2. `claude.ts` / `codex.ts` 跟着改方法名和返回类型，实现体不变；
   返回对象需补 `runtime: 'host'` 字段（Stage 1 `LaunchSpec` 要求）。
3. `agent-driver/types.ts` 删除 `SpawnSpec` 类型（L26-31），`adapter.ts` 不再 import。
4. 不改 `sessionParams` / `parseUpdate` / `cleanup` —— 这几个是 ACP 语义，运行时无关。

**接口契约（Wave 2 看这里）**

```ts
// adapter.ts 改造后
import type { LaunchSpec } from '../../process-runtime/types.js';

export interface AgentAdapter {
  prepareLaunch(config: DriverConfig): LaunchSpec;   // ← 改名 + 换类型
  sessionParams(config: DriverConfig): Record<string, unknown>;
  parseUpdate(update: unknown): DriverEvent | null;
  cleanup(): void;
}
```

```ts
// claude.ts / codex.ts 示意
prepareLaunch(config: DriverConfig): LaunchSpec {
  return {
    runtime: 'host',                              // ← 新增
    command: 'npx',
    args: [/* ... */],
    env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
    cwd: config.cwd,
  };
}
```

**交付清单**

- `packages/backend/src/agent-driver/adapters/adapter.ts`（小改）
- `packages/backend/src/agent-driver/adapters/claude.ts`（小改）
- `packages/backend/src/agent-driver/adapters/codex.ts`（小改）
- `packages/backend/src/agent-driver/types.ts`（删 `SpawnSpec`）
- `packages/backend/src/agent-driver/adapters/__tests__/claude.adapter.test.ts`（若无新增，若有追加 `prepareLaunch` 用例）
- `packages/backend/src/agent-driver/adapters/__tests__/codex.adapter.test.ts`（同上）
- `packages/backend/src/agent-driver/adapters/README.md`（新增，见 WORKFLOW §3）

**README.md 必含**

1. 这个模块是什么（一句话：ACP adapter 把"怎么起一个 ACP agent"封装起来）
2. `AgentAdapter` 接口签名（TypeScript，含 4 个方法）
3. 新增 adapter 的 3-5 行示例（实现 4 个方法 + `createAdapter` 注册）
4. 为什么 `prepareLaunch` 不返回 `RuntimeHandle`（adapter 只产规格，runtime 才负责 spawn）

**完成判据**

- `pnpm tsc --noEmit` 通过（Wave 1 驱动层其他模块若未完工会报错是正常的，此项在 Wave 2 回归时统一验）
- 两个 adapter 的单测 `prepareLaunch` 返回对象含 `runtime: 'host'`、`command: 'npx'`
- 代码库 grep `prepareSpawn`、`SpawnSpec` 在 `agent-driver/` 目录下清零

---

### 1.2 mod-driver-decouple

| 字段 | 值 |
|------|----|
| 模块目录 | `packages/backend/src/agent-driver/`（改 `driver.ts`、新增 `driver-events.ts`、新增测试） |
| 负责人 | _待 leader 派单_ |
| 预估代码 | `driver.ts` 目标 ~140 行（只留 ACP 协议逻辑）；新增 `driver-events.ts` ~60 行（事件类型 + Subject + `events$` 暴露） |
| 预估测试 | 新增 `__tests__/driver.test.ts` ~180 行，5-6 个用例；新增 `__tests__/driver-events.test.ts` ~30 行（Subject emit/complete 契约） |
| 依赖 | Stage 1 `RuntimeHandle` 类型（`process-runtime/types.ts`） |
| 阻塞 | 不阻塞 mod-adapter-launch / mod-bus-bridge（接口已约定） |

> **行数硬性要求：** 原始估算（driver.ts ~170 行）已贴近 200 行红线；Stage 4 W2-C 不再往 driver.ts 里加东西，但为了留足缓冲 + 职责清晰，**必须**把事件相关代码抽出独立文件 `driver-events.ts`。抽出后 driver.ts 只剩 ACP 协议逻辑（握手 / session / prompt / teardown），events 相关的类型定义、Subject 创建、`emit()` 封装、`events$` Observable 暴露全部归 `driver-events.ts`。

**要做什么**

1. **删除** `driver.ts` 对 `node:child_process` / `node:stream` 的 import（L5-6）。
   eslint `no-restricted-imports` 规则兜底（见下文）。
2. **构造函数** 加参数 `handle: RuntimeHandle`（位置：id 和 config 之后，
   可选的 adapter 再往后，便于测试注入假 adapter）：
   ```ts
   constructor(
     id: string,
     config: DriverConfig,
     handle: RuntimeHandle,
     adapter?: AgentAdapter,              // 可选，默认走 createAdapter(config)
   )
   ```
3. **删除** `this.child: ChildProcess | null` 字段和所有 `spawn(...)` 调用（L79-85）。
4. **事件输出抽到 `driver-events.ts`**（职责切分，driver.ts 不再碰 RxJS）：

   **新增文件** `packages/backend/src/agent-driver/driver-events.ts`（~60 行），导出：

   ```ts
   // driver-events.ts
   import { Subject, type Observable } from 'rxjs';
   import type { DriverEvent } from './types.js';

   export type DriverLifecycleEvent =
     | { type: 'driver.started' }
     | { type: 'driver.stopped' }
     | { type: 'driver.error'; message: string };

   export type DriverOutputEvent = DriverEvent | DriverLifecycleEvent;

   export class DriverEventEmitter {
     private readonly subject = new Subject<DriverOutputEvent>();
     readonly events$: Observable<DriverOutputEvent> = this.subject.asObservable();

     emit(ev: DriverOutputEvent): void { this.subject.next(ev); }
     complete(): void { this.subject.complete(); }
   }
   ```

   **driver.ts 里使用：**
   - 新增私有字段 `private readonly emitter = new DriverEventEmitter()`
   - 公开只读 `readonly events$: Observable<DriverOutputEvent> = this.emitter.events$`
   - `dispatch(ev)` 改名 `emit(ev)`：实现改成 `this.emitter.emit(ev)`
   - `stop()` 末尾调用 `this.emitter.complete()`（见下方决策 B）
   - **不要**在 driver.ts 里 `import { Subject }`；所有 RxJS 细节收敛在 driver-events.ts
   - 类型 `DriverLifecycleEvent` / `DriverOutputEvent` 从 driver-events.ts 导入

   **为什么抽：** driver.ts 目标 ≤140 行（纯 ACP 协议层）；driver-events.ts 独立承担"事件流"职责；bus-bridge / primary-agent `import type { DriverOutputEvent } from '../agent-driver/driver-events.js'` 语义更清晰。
5. **stdio 接入改 handle**：
   ```ts
   // 旧：Writable.toWeb(child.stdin!) ...
   // 新：
   const { stdin, stdout } = this.handle.stdio;
   const stream = acp.ndJsonStream(stdin, stdout);
   ```
   若 Stage 1 的 `RuntimeHandle` 暴露是 `readonly stdin/stdout` 顶层字段（见 §2 `stage-1-process-runtime.md`），直接 `this.handle.stdin` / `this.handle.stdout`，一致即可。
6. **exit 订阅改 handle.onExit**：
   ```ts
   this.handle.onExit((code, signal) => {
     if (this.status === 'STOPPED') return;
     this.status = 'STOPPED';
     this.emit({ type: 'driver.error', message: `runtime exited (code=${code}, signal=${signal})` });
     this.emit({ type: 'driver.stopped' });       // 见"关键决策 A"
   });
   ```
7. **teardown() 只清协议**：
   - 保留 `adapter.cleanup()`、清 `sessionId` / `conn`。
   - **删除** 自实现的 SIGTERM/SIGKILL 宽限逻辑（L132-138）。
   - **默认不调 `handle.kill()`**（见 `stage-2-driver-decouple.md §4.3`，
     Docker 下"关会话 ≠ 关容器"，杀进程由调用方决定）。
8. **stop() 流程**：`teardown()` → 状态置 `STOPPED` → `emit({ type: 'driver.stopped' })`
   （注意：`emit` 用 Subject 推，订阅方自行决定写 bus / 断言测试）。
9. **start() 失败路径**：`teardown()` → `STOPPED` → `emit({ type: 'driver.error' })` → 抛错
   （保留现有语义，不 emit `driver.stopped`，避免上层重复清理）。
10. **导出类型**：`DriverLifecycleEvent` / `DriverOutputEvent` 定义 + 导出**统一放在** `driver-events.ts`（见第 4 步）。driver.ts 只 `import type { DriverOutputEvent } from './driver-events.js'`；**不要**再在 `types.ts` 或 `driver.ts` 重复定义。
11. **行数自检**：实现完 `wc -l driver.ts driver-events.ts`，两文件都必须 ≤200 行；driver.ts 应 ≤150 行（纯 ACP 逻辑），否则说明事件/生命周期代码没抽干净，回去继续拆。

**接口契约（Wave 2 / bus-bridge 看这里）**

```ts
// driver-events.ts（新文件，单一职责：事件类型 + Subject 封装）
import { Subject, type Observable } from 'rxjs';
import type { DriverEvent } from './types.js';

export type DriverLifecycleEvent =
  | { type: 'driver.started' }
  | { type: 'driver.stopped' }
  | { type: 'driver.error'; message: string };

export type DriverOutputEvent = DriverEvent | DriverLifecycleEvent;

export class DriverEventEmitter {
  private readonly subject = new Subject<DriverOutputEvent>();
  readonly events$: Observable<DriverOutputEvent> = this.subject.asObservable();
  emit(ev: DriverOutputEvent): void { this.subject.next(ev); }
  complete(): void { this.subject.complete(); }
}

// driver.ts 改造后（摘要，不再 import Subject）
import type { Observable } from 'rxjs';
import type { RuntimeHandle } from '../process-runtime/types.js';
import { DriverEventEmitter, type DriverOutputEvent } from './driver-events.js';

export class AgentDriver {
  readonly id: string;
  readonly config: DriverConfig;
  readonly events$: Observable<DriverOutputEvent>;   // ← 新增
  status: DriverStatus;

  constructor(id: string, config: DriverConfig, handle: RuntimeHandle, adapter?: AgentAdapter);

  isReady(): boolean;
  start(): Promise<void>;                            // ACP 握手 + session/new
  prompt(message: string): Promise<void>;
  stop(): Promise<void>;                             // 只关协议，默认不 kill handle
}
```

**关键决策（给实现者）**

- **A. runtime exit 时同时 emit `driver.error` + `driver.stopped`**：
  原实现只 emit `driver.error`，调用方通过 `bus.events$` 感知挂掉需要多过一层翻译。
  改造后 driver 先发 error（说明原因），再发 stopped（表示生命周期结束），
  符合 "error 不终止 subject，stopped 才终止" 的 RxJS 惯例。
  见 `stage-2-driver-decouple.md §4.2`（原版只 emit error 是旧行为，改造后两个都发）。
  → 这里对齐 primary-agent 现有 `handleDriverStopped` 逻辑（`primary-agent.ts:127-130`）。
- **B. `emitter` 在 `stop()` 末尾 `complete()`**：
  `this.emitter.complete()`，让订阅者天然收敛，避免泄漏。
  bus-bridge 订阅会自动结束，不需要上层手动 unsubscribe。
- **C. 不再内部 `createAdapter`**：构造函数可选的 `adapter` 参数是为了测试注入 fake；
  默认值仍走 `createAdapter(config)`（保持对 primary-agent 透明）。

**eslint 兜底（负责人同时加）**

在 `packages/backend/eslint.config.js` 或 `.eslintrc` 里给 `agent-driver/` 目录加
`no-restricted-imports`：禁止 `node:child_process` / `node:stream` / `node-pty`。
`bus-bridge.ts` 可能不需要这些，但放一起约束目录更简单。

**交付清单**

- `packages/backend/src/agent-driver/driver.ts`（大改，目标 ≤150 行；只留 ACP 协议逻辑）
- `packages/backend/src/agent-driver/driver-events.ts`（**新增**，~60 行；事件类型 + `DriverEventEmitter`）
- `packages/backend/src/agent-driver/types.ts`（只删 `SpawnSpec`，由 mod-adapter-launch 负责；**不要**在这里定义 `DriverLifecycleEvent` / `DriverOutputEvent`，统一放 driver-events.ts）
- `packages/backend/src/agent-driver/__tests__/driver.test.ts`（新增）
- `packages/backend/src/agent-driver/__tests__/driver-events.test.ts`（**新增**，~30 行；覆盖 emit / events$ 多订阅 / complete 后再 emit 无效 3 个用例）
- `packages/backend/src/agent-driver/README.md`（新增，见 WORKFLOW §3）
- `packages/backend/eslint.config.*`（追加 no-restricted-imports）

**README.md 必含**

1. 这个模块是什么（一句话：ACP 协议适配器，只跑握手/session/prompt）
2. `AgentDriver` 公开签名（构造/start/prompt/stop/events$）
3. 3-5 行使用示例（`new AgentDriver(id, cfg, handle, adapter); driver.events$.subscribe(...); await driver.start()`）
4. 边界行为：
   - `stop()` 默认不 kill handle（理由 + 调用方如何自己 kill）
   - runtime exit 时 emit `driver.error` + `driver.stopped` 两条
   - `start()` 超时 30s → teardown + 抛错

**完成判据**

- `grep -r "from 'node:child_process'" packages/backend/src/agent-driver/` 无结果
- `grep -r "spawn(" packages/backend/src/agent-driver/driver.ts` 无结果（排除注释）
- `grep "new Subject" packages/backend/src/agent-driver/driver.ts` 无结果（Subject 应只在 driver-events.ts 里出现）
- `wc -l packages/backend/src/agent-driver/driver.ts` ≤ 150
- `wc -l packages/backend/src/agent-driver/driver-events.ts` ≤ 80
- `driver.test.ts` + `driver-events.test.ts` 用例全部 pass，且不起真进程（用 MockRuntimeHandle）
- `driver.ts` + `driver-events.ts` 合计单测覆盖率 ≥ 90%

---

### 1.3 mod-bus-bridge

| 字段 | 值 |
|------|----|
| 模块目录 | `packages/backend/src/agent-driver/`（改 `bus-bridge.ts`、新增测试） |
| 负责人 | _待 leader 派单_ |
| 预估代码 | `bus-bridge.ts` 净 ~55 行（原 54 行，改签名后基本等长） |
| 预估测试 | 新增 `__tests__/bus-bridge.test.ts` ~80 行，7 个事件类型各一 case |
| 依赖 | `rxjs.Observable` / `rxjs.Subscription`（已有） |
| 阻塞 | 类型 `DriverOutputEvent` 来自 mod-driver-decouple，但仅类型依赖，可独立编写（用 `import type`） |

**要做什么**

1. **删除** `emitToBus(driverId, ev)` 导出。
2. **新增** `attachDriverToBus(driverId, events$)` 导出：
   ```ts
   import type { Observable, Subscription } from 'rxjs';
   import type { DriverOutputEvent } from './driver-events.js';  // ← 从 driver-events.ts 拿类型

   export function attachDriverToBus(
     driverId: string,
     events$: Observable<DriverOutputEvent>,
   ): Subscription {
     return events$.subscribe((ev) => translate(driverId, ev));
   }
   ```
3. **`translate(driverId, ev)` 内部方法** 保留原 `emitToBus` 的 switch 逻辑，**一行不改**。
4. **`DriverBusEvent` 类型**：
   - 删除 `bus-bridge.ts` 的本地定义，统一 `import type { DriverOutputEvent } from './driver-events.js'`。
   - 若别处仍 import `DriverBusEvent`，在 bus-bridge.ts 补 `export type { DriverOutputEvent as DriverBusEvent }` 兼容别名。
   - 用 grep 确认除 `driver-events.ts` 外无别处原始定义，可直接删除兼容别名。

**接口契约（Wave 2 看这里）**

```ts
// bus-bridge.ts 改造后
export function attachDriverToBus(
  driverId: string,
  events$: Observable<DriverOutputEvent>,
): Subscription;
```

调用方约定：
- 在 `primary-agent.start()` 拿到 `driver.events$` 后调 `attachDriverToBus(driverId, driver.events$)`。
- 返回的 `Subscription` 由调用方在 `stop()` 时 `unsubscribe()`，或依赖 `driver` 内部 `complete()` 自动收敛（见 mod-driver-decouple 决策 B）。

**交付清单**

- `packages/backend/src/agent-driver/bus-bridge.ts`（改）
- `packages/backend/src/agent-driver/__tests__/bus-bridge.test.ts`（新增）
- `packages/backend/src/agent-driver/bus-bridge.README.md`（可并入 `agent-driver/README.md`，或独立一份均可）

**README 要点（并入 `agent-driver/README.md`）**

1. 这个模块是什么（一句话：`DriverOutputEvent` → bus `BusEvent` 的只读订阅桥）
2. `attachDriverToBus` 签名
3. 3-5 行示例（含 `Subscription` 管理）
4. 注意：幂等 —— 同一个 driverId + events$ 多次 attach 会产生多份订阅，上层要自己去重

**完成判据**

- 7 种事件（started/stopped/error/thinking/text/tool_call/tool_result/turn_done）全部覆盖
- 每个 case 通过 `bus.events$` 断言翻译后的 BusEvent 形状
- 不 mock `bus`，用真实 `EventBus` 实例（WORKFLOW §6.3 不 mock bus）

---

## 2. Wave 2 — 业务模块

### 2.1 glue-primary-agent

| 字段 | 值 |
|------|----|
| 模块目录 | `packages/backend/src/primary-agent/` |
| 负责人 | _待 leader 派单_ |
| 预估代码 | `primary-agent.ts` 净 +25 / -15 |
| 预估测试 | 新增/扩展 `primary-agent.test.ts`（含 MockRuntime 集成用例），~120 行 |
| 依赖 | Wave 1 三个模块全部完成；Stage 1 的 `ProcessRuntime` / `HostRuntime` |
| 阻塞 | Wave 2 仅此一个胶水，不与其他胶水并行 |

**要做什么**

1. **`PrimaryAgent` 构造函数加依赖**：
   ```ts
   constructor(
     private readonly eventBus: EventBus = defaultBus,
     private readonly runtime: ProcessRuntime = hostRuntime,     // ← 新增
   ) {}
   ```
   默认值 `hostRuntime` 从 `process-runtime/index.ts` 导出（Stage 1 已落地）。
2. **`start()` 改造**（对应 `primary-agent.ts:60-94`）：
   ```ts
   const adapter = createAdapter(config);                     // driver 导出
   const spec = adapter.prepareLaunch(config);
   const handle = await this.runtime.spawn(spec);
   const driver = new AgentDriver(row.id, config, handle, adapter);
   this.driver = driver;
   this.driverHandle = handle;                                 // 新增字段，stop 时用
   this.subscribeDriverEvents(row.id);
   try {
     await driver.start();
   } catch (err) {
     this.unsubscribeDriver();
     await handle.kill().catch(() => { /* ignore */ });         // ← 胶水负责杀进程
     this.driver = null;
     this.driverHandle = null;
     throw err;
   }
   ```
3. **`stop()` 改造**（对应 `primary-agent.ts:96-111`）：
   ```ts
   const driver = this.driver;
   const handle = this.driverHandle;
   this.unsubscribeDriver();
   this.driver = null;
   this.driverHandle = null;
   if (driver) { try { await driver.stop(); } catch { /* */ } }
   if (handle) { try { await handle.kill(); } catch { /* */ } }    // ← 胶水负责
   // ... setStatus + emit primary_agent.stopped 保留
   ```
4. **`subscribeDriverEvents()` 改造**（对应 L117-133）：
   ```ts
   private subscribeDriverEvents(agentId: string): void {
     if (!this.driver) return;
     const busSub = attachDriverToBus(agentId, this.driver.events$);    // 新 API
     const logicSub = this.driver.events$.subscribe((ev) => {
       if (ev.type === 'driver.error') {
         process.stderr.write(`[primary-agent] driver error: ${ev.message}\n`);
         void this.handleDriverFailure(agentId);
       } else if (ev.type === 'driver.stopped') {
         this.handleDriverStopped(agentId);
       }
     });
     this.driverSubs = [busSub, logicSub];
   }
   ```
   字段 `driverSub: Subscription | null` 改 `driverSubs: Subscription[]`。
5. **`handleDriverFailure` / `handleDriverStopped`** 保持原语义，
   但 `driver.stop()` 之外加 `handle.kill()`（防止 runtime 进程遗留）：
   见步骤 3 的公共清理路径，两个 handler 合流到同一个清理方法。
6. **`createAdapter`** 从 `driver.ts` 导出（Stage 2 设计文档 §4.5 明确要求）。
   做法：把 `driver.ts:146-156` 的 `createAdapter` 函数前加 `export`。
   **注意**：这一步由 mod-driver-decouple 在 Wave 1 顺手做掉，glue 这边只负责 import 使用。
   → 架构上已在"mod-driver-decouple 交付清单"中标注，Wave 1 完成即可用。

**接口契约**

- `PrimaryAgent` 对外行为不变（`configure/start/stop/getConfig/isRunning/boot/teardown`）。
- 新增构造参数 `runtime` 为可选，默认 `hostRuntime`，对外语义零破坏。
- 内部新增字段 `driverHandle: RuntimeHandle | null`，仅供本类使用。

**时序图（README 必含，WORKFLOW §3 业务模块额外要求）**

```
PrimaryAgent.start()
    │
    ├─ 1. readRow() / cliManager.isAvailable 校验
    ├─ 2. buildDriverConfig(row) → { config }
    ├─ 3. createAdapter(config)  ────────────────────┐
    ├─ 4. adapter.prepareLaunch(config) → spec       │ 同步
    ├─ 5. runtime.spawn(spec) → handle ──────────────┤ 异步（await）
    ├─ 6. new AgentDriver(id, cfg, handle, adapter)  │
    ├─ 7. subscribeDriverEvents():                   │
    │     ├─ attachDriverToBus(id, driver.events$)  │
    │     └─ driver.events$.subscribe(logicHandler) │
    ├─ 8. driver.start() (ACP 握手 + session/new) ──┘ 异步
    │   ├─ 成功 → setStatus RUNNING + emit primary_agent.started
    │   └─ 失败 → unsubscribe + handle.kill() + 抛错
    │
    └─ 返回 row
```

**竞态分析（README 必含）**

| 场景 | 风险 | 解决 |
|------|------|------|
| `start()` 中 `runtime.spawn` 成功后、`driver.start()` 失败前，调用方 `stop()` | `handle` 已拿到但 `this.driver` 还未赋值；`stop()` 读不到 | `start()` 赋值 `this.driverHandle = handle` 要放在 `runtime.spawn` 之后、`driver.start()` 之前；`stop()` 读 `driverHandle` 兜底 kill |
| `driver.events$` 在 `handleDriverFailure` 里再次 emit（先 error 再 stopped） | 触发两次 `handleDriverFailure` / `handleDriverStopped` | `handleDriverFailure` 里先 `this.driver = null`，`handleDriverStopped` 开头判 `if (!this.driver) return` 已做幂等 |
| 同一个 agent 两次 `configure(cliChanged)` 快速连发 | `stop()` 还没完 `start()` 就被触发，双 driver 并存 | `configure()` 里 `await this.stop()` 必须在 `this.start()` 前完成（现有实现已串行） |
| `runtime.spawn` 抛错（镜像缺失 / fs 权限） | 没有 driver 实例，`this.driver` 仍为 null，但 `cliManager.isAvailable` 已通过 | `start()` 捕获 `spawn` 抛错直接 throw，让 configure / 外部 start 调用方看到原始错误 |

**错误传播路径（README 必含）**

```
runtime.spawn 失败
   └─> start() 直接 throw（未创建 driver）
       └─> configure 上层捕获 / boot 写 stderr

driver.start 失败（ACP 握手 / session/new 超时）
   └─> driver 内部 teardown → emit driver.error + driver.stopped
       └─> events$ 订阅者收到
           ├─ bus-bridge → bus.events$
           └─ primary-agent.handleDriverFailure
               └─> handle.kill() + setStatus STOPPED + emit primary_agent.stopped
       └─> start() catch 块 handle.kill() + 抛错给外部

runtime 进程崩溃（子进程 SIGKILL / 异常 exit）
   └─> handle.onExit 触发
       └─> driver emit driver.error + driver.stopped
           └─> primary-agent.handleDriverStopped
               └─> handle.kill() 幂等（已退出则 no-op）+ setStatus STOPPED
```

**交付清单**

- `packages/backend/src/primary-agent/primary-agent.ts`（中改）
- `packages/backend/src/primary-agent/__tests__/primary-agent.test.ts`（新增/扩展）
- `packages/backend/src/primary-agent/README.md`（新增，含时序图 + 竞态 + 错误传播）

**完成判据**

- 单测覆盖：configure/start/stop/driver.error/runtime.exit 5 条主路径
- 不起真进程（用 Stage 1 的 `MockRuntime` / `MockRuntimeHandle`）
- `pnpm tsc --noEmit` 全仓绿
- `primary-agent.ts` 单文件 ≤ 200 行（目前 169 行，改造后约 180-190 行）

---

## 3. 接口契约冻结表

Wave 2 执行时必须按以下契约开发，Wave 1 完成后任何变更需 leader 同意。

| 契约 | 定义位置 | 消费方 |
|------|----------|--------|
| `AgentAdapter.prepareLaunch(config): LaunchSpec` | `adapters/adapter.ts` | glue-primary-agent |
| `new AgentDriver(id, config, handle, adapter?)` | `agent-driver/driver.ts` | glue-primary-agent |
| `driver.events$: Observable<DriverOutputEvent>` | `agent-driver/driver.ts`（实现） / `agent-driver/driver-events.ts`（类型） | bus-bridge / glue-primary-agent |
| `driver.stop(): Promise<void>` 不 kill handle | `agent-driver/driver.ts` | glue-primary-agent（自己 kill） |
| `DriverOutputEvent` 类型 + `DriverEventEmitter` | `agent-driver/driver-events.ts` | driver.ts / bus-bridge / glue-primary-agent |
| `attachDriverToBus(id, events$): Subscription` | `agent-driver/bus-bridge.ts` | glue-primary-agent |
| `createAdapter(config): AgentAdapter` 导出 | `agent-driver/driver.ts` | glue-primary-agent |

---

## 4. 不在本 Stage 范围

显式列出避免误伤：

- `packages/backend/src/bus/events.ts` / `helpers.ts` —— bus 自身不动。
- `packages/backend/src/primary-agent/driver-config.ts` / `repo.ts` —— 配置与 DB 层不动。
- `packages/backend/src/pty/` —— PTY 废弃在 Stage 3，本 Stage 不动。
- Docker runtime 的 `spawn` 实现 —— 留 Stage 4；本 Stage 仅要求 `HostRuntime` 跑通。
- MCP HTTP 化 —— Stage 4；本 Stage 照旧透传 `config.mcpServers`。

---

## 5. 执行顺序建议

```
Day 1 ─┬─ 派 mod-adapter-launch （一人，~2h）
       ├─ 派 mod-driver-decouple （一人，~6h，含测试）
       └─ 派 mod-bus-bridge       （一人，~2h）

Day 2 ── 全员撤，leader 派 glue-primary-agent （一人，~4h）

Day 3 ── 测试员按 REGRESSION.md 逐条验 → 出报告
```

各模块间用 `import type` 约定，即使 Wave 1 内部某个模块未完成，
其他模块也能通过类型契约独立完成编译。
