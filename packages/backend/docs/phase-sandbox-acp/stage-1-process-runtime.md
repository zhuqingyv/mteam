# Stage 1 — process-runtime 运行时抽象层

> 本文档基于当前代码（commit `dff9cd4`）撰写。引用格式：`相对路径:行号`。

---

## 1. 目标

当前所有"起一个子进程"的逻辑硬编码为 `node:child_process.spawn`（见 `packages/backend/src/agent-driver/driver.ts:81-85`）和 `node-pty.spawn`（见 `packages/backend/src/pty/manager.ts:104-110`）。这意味着 agent 子进程与宿主机共用文件系统、网络、进程空间，无隔离边界。后续要支持 Docker / microVM 沙箱执行时，整条调用链都得侵入改写。

`process-runtime` 模块的作用：把"在哪里执行一个进程"抽象成一个接口，让上层（AgentDriver、PtyManager）只面对 `RuntimeHandle` 这样的统一句柄，不再关心进程是跑在宿主机还是容器里。

本 Stage 只做**运行时抽象与宿主实现**，不动沙箱、不动 ACP，保持纯重构。产出：

- `RuntimeHandle` / `ProcessRuntime` / `LaunchSpec` 类型定义。
- `HostRuntime` 一个可用实现（封装 `child_process.spawn`）。
- `DockerRuntime` 只留接口和 stub，不实现。

---

## 2. 核心抽象 — RuntimeHandle 接口

`RuntimeHandle` 是对"一个正在运行的进程"的最小可用句柄。它只暴露调用方真正需要的能力，屏蔽 Node 原生的 `ChildProcess` / node-pty `IPty` 差异。

```typescript
interface RuntimeHandle {
  /** 进程标准输入。调用方通过它推送 JSON-RPC 请求或 PTY 键入。 */
  readonly stdin: WritableStream<Uint8Array>;

  /** 进程标准输出。调用方消费 JSON-RPC 响应或 PTY 回显。 */
  readonly stdout: ReadableStream<Uint8Array>;

  /**
   * 进程标识。
   * - 宿主机：number（OS pid）。
   * - 容器：string（container id / exec id）。
   */
  readonly pid: number | string;

  /**
   * 请求进程退出。默认 SIGTERM + 2s 宽限 → SIGKILL。
   * 容器运行时映射为 `docker stop -t 2`。
   * 幂等：多次调用等价于一次。
   */
  kill(signal?: string): Promise<void>;

  /**
   * 注册进程退出回调。
   * - `code`：正常退出码，被信号杀死时为 null。
   * - `signal`：被信号杀死时的信号名，正常退出时为 null。
   */
  onExit(cb: (code: number | null, signal: string | null) => void): void;
}
```

**设计要点**

- **stdin / stdout 用 Web Streams**：`driver.ts:96-97` 已经在把 Node stream 转成 Web stream 喂给 `acp.ndJsonStream`，直接用 Web Streams 作为接口语义可以少一次转换。PTY 场景由 `HostRuntime` 内部把 `IPty.onData` 适配成 `ReadableStream`。
- **pid 用联合类型**：宿主机上就是 OS pid；Docker 下 pid namespace 隔离，OS pid 没意义，用 container id 更合理。
- **kill 幂等、返回 Promise**：当前 `driver.teardown`（`driver.ts:126-139`）和 `ptyManager.kill`（`pty/manager.ts:155-164`）各自重复实现了 "SIGTERM → 2s → SIGKILL" 的宽限逻辑，抽到 `RuntimeHandle.kill` 里统一。
- **onExit 只允许一次注册**：语义简单、避免泄漏。多处需要监听的话由调用方用 `Promise` 分发。

---

## 3. ProcessRuntime 接口

`ProcessRuntime` 是"运行时"本身的工厂接口。上层拿到一个 `ProcessRuntime` 实例就能 `spawn`，不需要知道它后面是 host 还是 docker。

```typescript
interface ProcessRuntime {
  /** 根据 spec 启动一个进程，拿到句柄。 */
  spawn(spec: LaunchSpec): Promise<RuntimeHandle>;

  /**
   * 某个 CLI 在当前运行时里是否可用。
   * - Host：`which <cliType>` 或 `stat` 命令文件。
   * - Docker：检查目标镜像存在且包含该 CLI。
   * 用于启动前快速失败，避免 spawn 才发现。
   */
  isAvailable(cliType: string): Promise<boolean>;

  /** 关闭运行时自身（断开 docker client、清临时目录等）。 */
  destroy(): Promise<void>;
}
```

**为什么 `spawn` 返回 Promise 而不是同步？**
宿主机可以同步返回，但 Docker / microVM 创建过程是异步的（拉镜像、建 container）。为了让接口对所有实现都适用，统一成异步。

---

## 4. HostRuntime 实现

### 4.1 改造步骤

从 `driver.ts:79-94` 提取 `child_process.spawn` 逻辑。步骤：

1. 新建 `packages/backend/src/process-runtime/host-runtime.ts`。
2. 实现 `class HostRuntime implements ProcessRuntime`：
   - `spawn(spec)`：内部调 `child_process.spawn(spec.command, spec.args, { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] })`。
   - 把 `child.stdin` / `child.stdout` 用 `Writable.toWeb` / `Readable.toWeb` 适配成 Web Streams（语义和 `driver.ts:96-97` 一致）。
   - 把 `child.once('exit', ...)` 包装成 `RuntimeHandle.onExit`。
   - `kill(signal)`：SIGTERM → 2s 超时 → SIGKILL，复刻 `driver.ts:132-138` 的宽限逻辑。
3. `driver.ts:79-124` 的 `bringUp` 改为：
   - 通过依赖注入（构造函数参数）拿到 `ProcessRuntime` 实例。
   - 用 `runtime.spawn(spec)` 替换 `spawn(...)`。
   - 直接用 `handle.stdin` / `handle.stdout` 传给 `acp.ndJsonStream`，省去 Node→Web 转换。
   - `teardown` 改为 `await handle.kill()`，删除自己维护的 SIGKILL 定时器。

### 4.2 数据流图

```
┌───────────────────┐
│   AgentDriver     │  业务侧：持 RuntimeHandle，对接 ACP SDK
│  (driver.ts)      │
└──────┬────────────┘
       │ runtime.spawn(spec)
       ▼
┌───────────────────┐
│  HostRuntime      │  工厂：封装 child_process.spawn
│  (host-runtime.ts)│
└──────┬────────────┘
       │ child_process.spawn(command, args, {cwd, env, stdio})
       ▼
┌───────────────────┐
│  Node.js          │  OS 边界
│  child_process    │
└──────┬────────────┘
       │ fork/exec
       ▼
┌───────────────────┐
│  子进程            │  实际运行的 ACP agent / CLI
│  (npx ... agent)  │
└──────┬────────────┘
       │ stdin/stdout 管道
       ▼
┌───────────────────────────────────────────┐
│  RuntimeHandle                            │
│    stdin  : WritableStream<Uint8Array> ───┼──> 调用方写入
│    stdout : ReadableStream<Uint8Array> ───┼──> 调用方读取
│    pid    : number                        │
│    kill() : SIGTERM→2s→SIGKILL            │
│    onExit : (code, signal) => void        │
└───────────────────────────────────────────┘
```

---

## 5. DockerRuntime 接口预留

**本 Stage 不实现**，只留接口骨架，后续 Stage 4 填肉。目的是在 Stage 1 的时候就把"多运行时"的形状固化下来，避免 HostRuntime 长成 host-only 的样子。

```typescript
// process-runtime/docker-runtime.ts（Stage 1 只有骨架）
export class DockerRuntime implements ProcessRuntime {
  async spawn(_spec: LaunchSpec): Promise<RuntimeHandle> {
    throw new Error('DockerRuntime not implemented (reserved for Stage 4)');
  }
  async isAvailable(_cliType: string): Promise<boolean> {
    return false;
  }
  async destroy(): Promise<void> {
    /* no-op */
  }
}
```

**将来怎么实现（Stage 4 的事）**

- `spawn`：`docker run -i --rm -v <workdir>:<workdir> <image> <command> <args...>`。用 `dockerode` 或 CLI 都行。
- stdin/stdout：通过 docker attach API 拿到 multiplex 流，拆成 stdout/stderr，再适配成 Web Streams。
- pid：用 container id（string）。
- kill：`docker stop -t 2 <id>`。
- isAvailable：`docker image inspect <image>` + `docker run --rm <image> which <cliType>`。

---

## 6. LaunchSpec 类型

从 `packages/backend/src/agent-driver/types.ts:26-31` 的 `SpawnSpec` 演化而来。现有字段够用，只补一个 `runtime` 标签和可选的 `stdio` 配置（为 PTY 场景预留）。

```typescript
interface LaunchSpec {
  /** 选哪个运行时。目前只有 'host'，Stage 4 加 'docker'。 */
  runtime: 'host' | 'docker';

  /** 命令名（HostRuntime 下会走 PATH 查找；DockerRuntime 下是容器内路径）。 */
  command: string;

  /** 命令参数。 */
  args: string[];

  /** 环境变量（已合并好父进程 env，调用方自己合）。 */
  env: Record<string, string>;

  /** 工作目录。容器下是容器内路径。 */
  cwd: string;

  /** 可选：stdio 配置。默认 ['pipe', 'pipe', 'inherit']（对齐 driver.ts:84）。 */
  stdio?: StdioConfig;
}

type StdioMode = 'pipe' | 'inherit' | 'ignore';

interface StdioConfig {
  stdin?: StdioMode;   // 默认 'pipe'
  stdout?: StdioMode;  // 默认 'pipe'
  stderr?: StdioMode;  // 默认 'inherit'
}
```

**为什么引入 `runtime` 字段？**
让 `LaunchSpec` 自描述目标运行时，`ProcessRuntime` 的实现可以在 `spawn` 入口就校验 `spec.runtime` 和自身是否匹配，避免错用。后续 `RuntimeRegistry` 根据这个字段分发。

**与 `SpawnSpec` 的关系**
`SpawnSpec` 在本 Stage 之后会被替换成 `LaunchSpec`。具体迁移见 Stage 2 文档。Stage 1 先让两者并存：`adapter.prepareSpawn` 仍返回 `SpawnSpec`，driver 层在调用 runtime 前做一次 `SpawnSpec → LaunchSpec` 的浅映射（补一个 `runtime: 'host'`）。

---

## 7. 模块结构

```
packages/backend/src/process-runtime/
├── types.ts              — RuntimeHandle, ProcessRuntime, LaunchSpec, StdioConfig
├── host-runtime.ts       — HostRuntime 实现
├── docker-runtime.ts     — DockerRuntime 骨架（stub, Stage 4 填肉）
├── index.ts              — 对外导出
└── __tests__/
    ├── host-runtime.test.ts     — 契约测试
    └── launch-spec.test.ts      — 类型守卫/字段校验
```

`index.ts` 导出：

```typescript
export type {
  RuntimeHandle,
  ProcessRuntime,
  LaunchSpec,
  StdioConfig,
  StdioMode,
} from './types.js';
export { HostRuntime } from './host-runtime.js';
export { DockerRuntime } from './docker-runtime.js';
```

---

## 8. 改动文件清单

> 本 Stage 只做抽象层和 HostRuntime。PtyManager、DriverConfig 扩展等都不在本 Stage 范围（留给 Stage 2）。

| 文件 | 动作 | 改什么 |
|------|------|--------|
| `packages/backend/src/process-runtime/types.ts` | **新增** | `RuntimeHandle` / `ProcessRuntime` / `LaunchSpec` / `StdioConfig` 定义。 |
| `packages/backend/src/process-runtime/host-runtime.ts` | **新增** | `HostRuntime` 类，封装 `child_process.spawn`，提供统一句柄。 |
| `packages/backend/src/process-runtime/docker-runtime.ts` | **新增** | `DockerRuntime` stub（所有方法抛 "not implemented" 或返回 false）。 |
| `packages/backend/src/process-runtime/index.ts` | **新增** | 对外 re-export。 |
| `packages/backend/src/process-runtime/__tests__/host-runtime.test.ts` | **新增** | 见 §9。 |
| `packages/backend/src/process-runtime/__tests__/launch-spec.test.ts` | **新增** | 见 §9。 |
| `packages/backend/src/agent-driver/driver.ts` | **暂不改** | Stage 1 不改业务代码，保留 `child_process.spawn` 不动。Stage 2 再替换成 `HostRuntime`。 |
| `packages/backend/src/pty/manager.ts` | **暂不改** | 同上。Stage 3 统一迁移。 |

**核心原则**：Stage 1 只新增文件、不改现有业务代码，保证本阶段可独立合入且零回归风险。

---

## 9. 测试策略

### 9.1 HostRuntime 契约测试

放在 `packages/backend/src/process-runtime/__tests__/host-runtime.test.ts`。用真实子进程，不 mock（遵循项目"不 mock 测试"红线，见 `CLAUDE.md` 全局规则）。

用例：

| 测试名 | 动作 | 断言 |
|--------|------|------|
| `spawn echo 能拿到输出` | `spawn({ command: 'node', args: ['-e', 'process.stdout.write("hello")'] })` | `stdout` 读到 `"hello"`。 |
| `stdin 写入能被子进程读到` | spawn 一个 `node -e "process.stdin.on('data', d => process.stdout.write(d))"` | 往 `stdin` 写 `"ping"`，从 `stdout` 读到 `"ping"`。 |
| `onExit 正常退出 code=0` | `spawn node -e "process.exit(0)"` | `onExit` 回调 `(0, null)`。 |
| `onExit 异常退出 code=2` | `spawn node -e "process.exit(2)"` | `onExit` 回调 `(2, null)`。 |
| `kill SIGTERM 能杀掉可优雅退出的进程` | 启动长驻 node 进程，调 `handle.kill()` | `onExit` 回调 `(null, 'SIGTERM')` 或 `(0, null)`。 |
| `kill 对忽略 SIGTERM 的进程 2s 内升级 SIGKILL` | 启动 `trap '' TERM; sleep 60` 的 shell | 2~3s 内 `onExit` 回调触发，`signal === 'SIGKILL'`。 |
| `kill 幂等` | 同一个 handle 连续 kill 两次 | 第二次不抛，`onExit` 只触发一次。 |
| `isAvailable('node')` | | 返回 `true`。 |
| `isAvailable('definitely-not-a-real-cli-xyz')` | | 返回 `false`。 |
| `env 透传` | `spawn node -e "process.stdout.write(process.env.FOO)"`, env 传 `{ FOO: 'bar' }` | stdout 读到 `"bar"`。 |
| `cwd 生效` | `spawn node -e "process.stdout.write(process.cwd())"`, cwd 传 `os.tmpdir()` | stdout 读到 tmpdir 路径。 |

### 9.2 LaunchSpec 类型守卫测试

`__tests__/launch-spec.test.ts`。纯单元测试：

- 构造一个合法 `LaunchSpec`，`isLaunchSpec(spec) === true`。
- 缺少 `command` / `args` / `cwd` / `env` 任意一个字段，`isLaunchSpec(...)` 返回 false。
- `runtime` 取 `'host'` / `'docker'` 之外的值返回 false。

守卫函数放在 `types.ts`：

```typescript
export function isLaunchSpec(x: unknown): x is LaunchSpec { /* ... */ }
```

### 9.3 DockerRuntime 骨架测试（可选）

一个 smoke 测试：`new DockerRuntime().spawn(...)` 抛 "not implemented"。目的是防御未来误用。

---

## 10. 架构图 — process-runtime 在整体中的位置

```
                      ┌──────────────────────────────────────────┐
                      │           业务层（不需要感知运行时）         │
                      │                                          │
                      │   ┌────────────┐       ┌──────────────┐  │
                      │   │ AgentDriver │       │  PtyManager  │  │
                      │   │ (ACP 客户端) │       │  (PTY 客户端) │  │
                      │   └──────┬──────┘       └──────┬───────┘  │
                      │          │                     │           │
                      └──────────┼─────────────────────┼───────────┘
                                 │  runtime.spawn      │
                                 │  (LaunchSpec)       │
                                 ▼                     ▼
     ┌────────────────────────────────────────────────────────────┐
     │              process-runtime（本 Stage 产出）                │
     │                                                            │
     │       ┌──────────────────────────────────────┐             │
     │       │  ProcessRuntime 接口                  │             │
     │       │    spawn / isAvailable / destroy     │             │
     │       └──────────────────────────────────────┘             │
     │                 ▲                    ▲                      │
     │                 │                    │                      │
     │       ┌─────────┴──────┐   ┌─────────┴──────────┐          │
     │       │  HostRuntime   │   │   DockerRuntime    │          │
     │       │  (本 Stage 实现)│   │  (骨架, Stage 4 填肉)│        │
     │       └─────────┬──────┘   └─────────┬──────────┘          │
     │                 │                    │                      │
     └─────────────────┼────────────────────┼──────────────────────┘
                       │                    │
                       ▼                    ▼
     ┌────────────────────────┐   ┌────────────────────────┐
     │  Node.js               │   │  Docker Engine         │
     │  child_process.spawn   │   │  (docker run -i)       │
     └────────────┬───────────┘   └────────────┬───────────┘
                  │                            │
                  ▼                            ▼
     ┌────────────────────────┐   ┌────────────────────────┐
     │  宿主机进程             │   │  容器内进程             │
     │  (共享 fs/net)         │   │  (隔离 fs/net/pid)      │
     └────────────────────────┘   └────────────────────────┘

     ─────────────────────────────────────────────────────
     输入：LaunchSpec  { runtime, command, args, env, cwd, stdio? }
     输出：RuntimeHandle { stdin, stdout, pid, kill(), onExit() }
     ─────────────────────────────────────────────────────
```

**边界说明**

- **上游**：AgentDriver / PtyManager 只知道 `ProcessRuntime` 这个接口，不 import 任何 `node:child_process` 或 `node-pty`。
- **下游**：`HostRuntime` 封装 Node API，`DockerRuntime` 封装 Docker API。两者互不可见。
- **不变量**：同一个 `LaunchSpec` 喂给不同 Runtime，调用方看到的 `RuntimeHandle` 语义一致（stdin/stdout 字节流语义、kill 的宽限语义、onExit 的参数形状）。

---

## 附：与现有代码的对应关系速查

| 现有位置 | 现有代码 | Stage 1 归宿 |
|----------|----------|--------------|
| `driver.ts:81-85` | `spawn(spec.command, spec.args, { cwd, env, stdio: [...] })` | `HostRuntime.spawn` 内部实现 |
| `driver.ts:87-94` | `child.once('exit', ...)` | `HostRuntime` 包装为 `RuntimeHandle.onExit` |
| `driver.ts:96-97` | `Writable.toWeb(child.stdin)` / `Readable.toWeb(child.stdout)` | `HostRuntime` 内部做，作为 `RuntimeHandle.stdin/stdout` 暴露 |
| `driver.ts:132-138` | SIGTERM → 2s → SIGKILL 宽限逻辑 | `RuntimeHandle.kill` 内部实现 |
| `agent-driver/types.ts:26-31` | `SpawnSpec` | Stage 1 并存；Stage 2 替换为 `LaunchSpec` |
| `pty/manager.ts:104-110` | `ptySpawn(...)` | 本 Stage 不动；Stage 3 迁移到 runtime（或独立 PTY 适配） |
| `pty/manager.ts:155-164` | PTY 的 SIGTERM/SIGKILL 宽限 | 同上 |
