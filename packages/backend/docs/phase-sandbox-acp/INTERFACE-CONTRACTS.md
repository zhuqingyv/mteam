# Interface Contracts — 跨 Stage 冻结签名

> ⛔ **服务端底层接口，禁止前端调用**

> **受众**：**后端开发者 / 架构师（仅限后端内部）**。本文件冻结的是 `process-runtime` / `agent-driver` / `bus-bridge` 等**后端模块之间**的 TypeScript 接口，**不是前端 API**，也不是对外协议。前端开发者不需要阅读、消费或 import 本文件中的任何类型；前端接口请看 `docs/frontend-api/*`。
>
> **本文档是唯一权威**。所有 Stage 设计文档 / TASK-LIST 里的接口引用以本文件为准，如出现不一致，视为文档漂移，按本文件修正（不是按 Stage 文档修正本文件）。
>
> **适用范围**：Phase Sandbox-ACP 全阶段（Stage 1 ~ Stage 5），**后端内部**。
>
> **冻结时间**：接口一旦列入本文件即冻结，不得在 Stage TASK-LIST 或实现代码里擅自改名、加字段、改方法签名、改参数/返回类型。

---

## 目的

Stage 1 ~ Stage 5 涉及多个模块跨阶段协作：`process-runtime` 抽象在 Stage 1 交付 → Stage 2 driver 消费 → Stage 4 DockerRuntime 扩展 → Stage 5 container 生命周期订阅。任何一阶段私自改接口，都会让已合入的上游代码和下游正在开发的模块同时炸裂。

本文件把"跨 Stage 流通"的接口集中冻结，让每个模块只需 `import type { ... } from '<anchor>'` 即可消费，不必反推其他 Stage 的实现细节，也不需要各自维护自己的同构接口。

---

## 1. `RuntimeHandle`（进程句柄）

**权威定义位置**：`packages/backend/src/process-runtime/types.ts`（Stage 1 模块 A 落盘）

```typescript
export interface RuntimeHandle {
  /** 进程标准输入（Web Streams）。调用方写入字节即发送。 */
  readonly stdin: WritableStream<Uint8Array>;
  /** 进程标准输出（Web Streams）。调用方读取字节即接收。 */
  readonly stdout: ReadableStream<Uint8Array>;
  /** 进程标识。Host=OS pid(number)；Docker=container id(string)。 */
  readonly pid: number | string;
  /**
   * 请求进程退出。语义：SIGTERM → 2s 宽限 → SIGKILL。
   * 幂等：多次调用等价于一次调用，不抛错。
   * resolve 时机：进程已退出（onExit 已触发）。
   */
  kill(signal?: string): Promise<void>;
  /**
   * 注册进程退出回调。**只允许注册一次**；重复注册抛错。
   * - code：正常退出的退出码；被信号杀死时为 null。
   * - signal：被信号杀死时的信号名；正常退出时为 null。
   */
  onExit(cb: (code: number | null, signal: string | null) => void): void;
}
```

**要点**

- `stdin` / `stdout` 是顶层字段，不是 `handle.stdio.stdin`。任何文档写 `handle.stdio.{stdin,stdout}` 都是漂移。
- 无 `stderr` 字段。调用方若要 stderr，只能在 `LaunchSpec.stdio.stderr` 侧配 `'inherit'`/`'ignore'`，runtime 层不暴露 stderr 流。
- 无 `exit$` Observable。退出事件通过 `onExit(cb)` 单次注册；需要 Observable 包装请在消费侧自行 `fromEvent` 转换，不要给本接口加字段。
- `pid` 是联合类型 `number | string`，不要在 Stage 文档里收窄成单一类型。
- 名字永远是 **`RuntimeHandle`**，不得改名 `ProcessHandle`、`ContainerHandle`、`SandboxHandle` 等。

---

## 2. `ProcessRuntime`（进程运行时工厂）

**权威定义位置**：`packages/backend/src/process-runtime/types.ts`（Stage 1 模块 A 落盘）

```typescript
export interface ProcessRuntime {
  /** 根据 spec 启动进程。Docker 场景涉及异步（拉镜像/建容器），所以返回 Promise。 */
  spawn(spec: LaunchSpec): Promise<RuntimeHandle>;
  /**
   * 某个 CLI 在当前运行时里是否可用。启动前快速失败用。
   * Host：走 PATH 查找（等价 `which`）。
   * Docker：检查目标镜像存在且包含该 CLI。
   */
  isAvailable(cliType: string): Promise<boolean>;
  /** 关闭运行时自身（docker client 断开、清临时目录等）。幂等。 */
  destroy(): Promise<void>;
}
```

**要点**

- 启动方法永远叫 **`spawn`**，不叫 `start` / `launch` / `run` / `create`。任何文档写 `runtime.start(...)` 是漂移。
- `spawn` 返回 `Promise<RuntimeHandle>`（不是 `RuntimeHandle` 也不是 `{ handle, ... }`）。
- 三个方法名 `spawn` / `isAvailable` / `destroy` 全部冻结，不允许增删或改名。

---

## 3. `LaunchSpec`（进程启动规约）

**权威定义位置**：`packages/backend/src/process-runtime/types.ts`（Stage 1 模块 A 落盘）

```typescript
export type StdioMode = 'pipe' | 'inherit' | 'ignore';

export interface StdioConfig {
  stdin?: StdioMode;   // 默认 'pipe'
  stdout?: StdioMode;  // 默认 'pipe'
  stderr?: StdioMode;  // 默认 'inherit'
}

export interface LaunchSpec {
  /** 选哪个运行时。Stage 1 只有 'host' 可用；'docker' 保留给 Stage 4。 */
  runtime: 'host' | 'docker';
  /** 命令名。Host 走 PATH 查找；Docker 下是容器内绝对路径。 */
  command: string;
  /** 命令参数。 */
  args: string[];
  /** 环境变量。调用方自行合并父进程 env，runtime 不再追加。 */
  env: Record<string, string>;
  /** 工作目录。Host 为宿主机路径；Docker 为容器内路径。 */
  cwd: string;
  /** 可选：stdio 配置。默认 { stdin:'pipe', stdout:'pipe', stderr:'inherit' }。 */
  stdio?: StdioConfig;
}

/** 类型守卫。校验 runtime/command/args/env/cwd 五个必填字段。 */
export function isLaunchSpec(x: unknown): x is LaunchSpec;
```

**要点**

- **`runtime: 'host' | 'docker'`** 是必填字段（六字段中的第一个），不要和上层 builder 的 `runtimeKind` 概念混淆。
  - 上层编排代码里若有 `runtimeKind`（如 `primary-agent.ts`、`launch-spec-builder.ts`），它是"从 DB/配置读出来要跑哪种 runtime"的输入；必须在 builder 里原样映射到 `LaunchSpec.runtime`：`spec.runtime = input.runtimeKind`。**不允许存在两个不同字段名的同义字段同时出现在一个 LaunchSpec**。
- 字段集合固定为 6 个：`runtime` / `command` / `args` / `env` / `cwd` / `stdio?`。不允许额外加 `containerImage` / `user` / `memoryLimit` 等字段 —— 这些属于 runtime 实现内部配置（构造时注入），不是 spec。
- `env` 类型是 `Record<string, string>`，不是 `Record<string, string | undefined>`。调用方必须在 builder 里把父进程 env 合并好再传，runtime 不二次合并。

---

## 4. `DriverOutputEvent` 与 `driver.tool_call` 事件

> **面向**：后端 `agent-driver` / `bus-bridge` / bus subscriber 内部。
> **非面向**：前端。前端订阅的是 phase-ws 聚合后的 `turn.*` 事件（见 `turn-aggregator-design.md`），不直接消费 `driver.*`。

### 4.1 内部（driver → observer）事件类型

**权威定义位置**：`packages/backend/src/agent-driver/driver.ts`（Stage 2 改造后导出）

```typescript
// 来自 adapter.parseUpdate 的 ACP 语义事件
export type DriverEvent =
  | { type: 'driver.thinking'; content: string }
  | { type: 'driver.text'; content: string }
  | { type: 'driver.tool_call'; toolCallId: string; name: string; input: unknown }
  | { type: 'driver.tool_result'; toolCallId: string }
  | { type: 'driver.turn_done'; stopReason: string };

// driver 自身发的生命周期事件
export type DriverLifecycleEvent =
  | { type: 'driver.started' }
  | { type: 'driver.stopped' }
  | { type: 'driver.error'; message: string };

// driver.events$ 暴露的联合类型
export type DriverOutputEvent = DriverEvent | DriverLifecycleEvent;
```

**要点**

- `DriverOutputEvent` 就是 `DriverEvent | DriverLifecycleEvent` 这个并集，不允许再塞别的类型。
- `DriverEvent` 里各字段名 / 类型对齐 `packages/backend/src/agent-driver/types.ts`（Stage 2 前已有，Stage 2 保留不改），包括 `driver.tool_call` 必有 `toolCallId` / `name` / `input: unknown`。
- `driver.*` 事件里**没有 `driverId` 字段**。`driverId` 是 bus 外壳字段，在 `bus-bridge` 阶段由 `driverId` 参数注入（见 §4.2）。

### 4.2 bus 层 `driver.tool_call` 事件 shape

**权威来源**：`packages/backend/src/agent-driver/bus-bridge.ts`（Stage 2 改造前即定）

```typescript
// 经 attachDriverToBus(driverId, events$) 翻译后，bus 上的 driver.tool_call 形如：
{
  type: 'driver.tool_call',
  // ...makeBase 出来的外壳字段（id / timestamp / source 等，由 bus/helpers.ts 定义）
  driverId: string,
  name: string,
  input: Record<string, unknown>,
}
```

**要点**

- bus 层字段是 **`driverId`**（camelCase），不是 `driver_id`、`id`、`agentId`。Stage 5 订阅 `driver.tool_call` 时必须用 `ev.driverId` 取主键，再通过 `DriverInstanceMap.lookup(driverId)` 反查 `instanceId`。
- `name`: 工具名字符串（如 `Bash` / `mcp__mteam__search_members`），用于策略匹配。
- `input`: 工具入参，bus-bridge 会用 `toRecord` 归一化成 `Record<string, unknown>`。policy.subscriber 不要对 `input` 形状做强约束。

---

## 5. 修改流程

**"先改本文档，再改 Stage"** —— 反之违规。

1. **发现契约需要变更**（例如 `RuntimeHandle.pid` 实际用不上联合类型 / `ProcessRuntime.spawn` 需要新增第二个参数）：
   - 停下正在改的 Stage 代码。
   - 不要在 Stage TASK-LIST 或实现里自己"兼容"两种形态。
2. **在本文档提 PR**：修改对应章节 + 在文末变更日志加一行（日期 / 改了哪个签名 / 原因）。
3. **@ 架构师评审**：必须显式 approve。冻结的接口不允许未评审合入。
4. **评审通过后**：
   - 同步刷新所有引用该接口的 Stage 设计文档 / TASK-LIST（grep 全 `packages/backend/docs/phase-sandbox-acp/`）。
   - 同步刷新已落盘的实现（Stage 1 `types.ts`）。
   - 通知所有 in-flight 的 Stage 开发者。

---

## 6. 禁止事项

以下行为在任何 Stage 都明确禁止。发现即回退。

| # | 禁止的行为 | 正确做法 |
|---|-----------|---------|
| 1 | 把 `RuntimeHandle` 改名为 `ProcessHandle` / `ContainerHandle` / `SandboxHandle` | 永远用 `RuntimeHandle` |
| 2 | 写 `handle.stdio.stdin` / `handle.stdio.stdout` | 写 `handle.stdin` / `handle.stdout`（顶层字段） |
| 3 | 给 `RuntimeHandle` 加 `stderr` 字段引用 | stderr 由 `LaunchSpec.stdio.stderr` 配置模式，不暴露流 |
| 4 | 给 `RuntimeHandle` 加 `exit$: Observable<...>` | 用 `onExit(cb)` 单次注册；消费侧自己 `fromEvent` 转 Observable |
| 5 | 写 `runtime.start(...)` / `runtime.launch(...)` / `runtime.run(...)` | 永远用 `runtime.spawn(spec)` |
| 6 | 在 `LaunchSpec` 里加 `containerImage` / `user` / `memoryLimit` 等 | 这些是 runtime **构造时**的配置，不是 spec |
| 7 | 在 `LaunchSpec` 里省略 `runtime` 字段，或用 `runtimeKind` 代替 | `runtime: 'host' \| 'docker'` 是必填；上层 `runtimeKind` 在 builder 里映射到此字段 |
| 8 | 在 `driver.*` 事件本体（`DriverEvent`）里塞 `driverId` 字段 | `driverId` 是 bus 外壳字段，由 `bus-bridge` 注入 |
| 9 | 在 bus 层 `driver.tool_call` 事件里用 `driver_id` / `agentId` / `id` | 永远用 `driverId`（camelCase），Stage 5 policy.subscriber 按这个取键 |
| 10 | 在 Stage 文档实现小节里复制粘贴一份 `LaunchSpec` 定义（容易漂移） | 只写 `import type { LaunchSpec } from '.../process-runtime/types.js'`，参数字段引用本文件 §3 |
| 11 | 跳过本文件的评审流程直接改 Stage 里的接口引用 | 先改本文件，获 approve，再改 Stage 文档 / 实现 |

---

## 变更日志

| 日期 | 改动 | 作者 | 评审 |
|------|------|------|------|
| 2026-04-25 | 初版冻结（Stage 1 ~ Stage 5 质检后） | contract-fixer | - |
