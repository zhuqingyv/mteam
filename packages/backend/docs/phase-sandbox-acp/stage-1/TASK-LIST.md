# Stage 1 — 任务清单

> 依据：`packages/backend/docs/phase-sandbox-acp/stage-1-process-runtime.md`（设计文档）、`packages/backend/docs/phase-sandbox-acp/WORKFLOW.md`（流程规范）
> 原则：Stage 1 只**新增文件**、不改现有业务代码（`driver.ts`、`pty/manager.ts` 本 Stage 不动）。

---

## 0. 交付形态

所有代码落在 `packages/backend/src/process-runtime/` 新目录下。完成后目录形状：

```
packages/backend/src/process-runtime/
├── types.ts                        ← 模块 A
├── host-runtime.ts                 ← 模块 B
├── docker-runtime.ts               ← 模块 C
├── index.ts                        ← 模块 A
├── README.md                       ← 每个模块各自贡献自己那节
└── __tests__/
    ├── launch-spec.test.ts         ← 模块 A
    ├── host-runtime.test.ts        ← 模块 B
    └── docker-runtime.test.ts      ← 模块 C
```

**本 Stage 无业务模块**（胶水层）。Stage 1 只做纯抽象，不串接任何业务调用方。

---

## 1. 契约附录 — 所有人必看

以下类型是 Stage 1 的**跨模块契约**。任何 Wave 1 开发者无论先后开工都必须按此签名编码；模块 A 负责把这段代码原样落地到 `types.ts`，模块 B/C 按此 `import` 使用。**契约不允许 Wave 内私自修改**，如需调整必须先回来改本文档并 @ 架构师。

```typescript
// packages/backend/src/process-runtime/types.ts

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

/** 类型守卫。校验 runtime/command/args/env/cwd 五个必填字段。 */
export function isLaunchSpec(x: unknown): x is LaunchSpec;
```

`index.ts` 只做 re-export，内容固定为：

```typescript
export type {
  RuntimeHandle,
  ProcessRuntime,
  LaunchSpec,
  StdioConfig,
  StdioMode,
} from './types.js';
export { isLaunchSpec } from './types.js';
export { HostRuntime } from './host-runtime.js';
export { DockerRuntime } from './docker-runtime.js';
```

---

## 2. 模块拆分

### 2.1 非业务模块（Wave 1 并行）

| # | 模块名 | 代码位置 | 职责（一句话） | 接口契约（入/出） | 依赖 | 预估行数 |
|---|--------|---------|---------------|-----------------|------|---------|
| A | types & index | `packages/backend/src/process-runtime/types.ts` + `index.ts` + `__tests__/launch-spec.test.ts` | 落地 Stage 1 全部类型契约 + `isLaunchSpec` 守卫 + 对外 re-export | 入：§1 契约；出：导出 5 个类型 + 1 个守卫函数 + 2 个类名（re-export） | 无（契约即本文档） | ~80 |
| B | HostRuntime | `packages/backend/src/process-runtime/host-runtime.ts` + `__tests__/host-runtime.test.ts` | 封装 `child_process.spawn`，实现 `ProcessRuntime` 接口，产出符合契约的 `RuntimeHandle` | 入：`LaunchSpec`；出：`RuntimeHandle`（stdin/stdout Web Stream 化、kill 宽限、onExit 单次注册） | 只 import `./types.js`（§1 签名） | ~180 |
| C | DockerRuntime stub | `packages/backend/src/process-runtime/docker-runtime.ts` + `__tests__/docker-runtime.test.ts` | 骨架类：`spawn` 抛 `'DockerRuntime not implemented (reserved for Stage 4)'`、`isAvailable` 恒返 `false`、`destroy` no-op | 入：`LaunchSpec`；出：抛错 / false / void | 只 import `./types.js`（§1 签名） | ~40 |

**Wave 1 并行可行性说明**
- A / B / C **三个模块之间不相互 import 运行时代码**，只共享 `types.ts` 中的**类型**（类型是契约，不是实现）。
- 契约已在 §1 完整给出，B/C 的开发不需要等 A 先写完代码 —— 他们照 §1 的签名写自己的实现即可。
- 仅在**合入时**三份代码才会汇合编译；由合入人（leader）负责 A 先落盘再合 B/C。
- 不存在跨模块的运行时调用（B 不调 C、C 不调 B、A 不调 B/C）。

### 2.2 业务模块（Wave 2）

**本 Stage 无业务模块。**

原因：Stage 1 只新增抽象层，不改任何现有业务调用方（driver.ts / pty/manager.ts 本 Stage 冻结）。胶水改造归 Stage 2。

---

## 3. 模块详细规格

### 模块 A — types & index

**职责**：落地 §1 契约 + 守卫 + re-export。

**具体工作**
1. 新建 `packages/backend/src/process-runtime/types.ts`，原样落地 §1 中的类型定义。
2. 实现 `isLaunchSpec(x: unknown): x is LaunchSpec`。校验规则：
   - `x` 是 non-null object
   - `x.runtime === 'host' || x.runtime === 'docker'`
   - `typeof x.command === 'string' && x.command.length > 0`
   - `Array.isArray(x.args) && x.args.every(a => typeof a === 'string')`
   - `x.env` 是 object 且所有 value 都是 string
   - `typeof x.cwd === 'string' && x.cwd.length > 0`
   - `x.stdio` 要么是 undefined，要么是 object 且每个子字段（若存在）是 `'pipe'|'inherit'|'ignore'`
3. 新建 `packages/backend/src/process-runtime/index.ts`，按 §1 末尾给的固定内容落地。
4. 新建 `__tests__/launch-spec.test.ts`，覆盖守卫测试（见 REGRESSION.md §1）。
5. 新建 `README.md`（或追加到共享 README 的 "types" 小节），内容：模块一句话说明 + §1 的签名引用 + 3 行使用示例。

**禁止事项**
- 不 import `host-runtime.ts` / `docker-runtime.ts` 的具体实现代码（`index.ts` 的 re-export 不算 import 实现，只是重新导出类/构造函数引用）。
- 不写业务相关逻辑。
- 不给守卫函数加副作用（console.log 之类）。

### 模块 B — HostRuntime

**职责**：用 `child_process.spawn` 实现 `ProcessRuntime`，产出符合契约的 `RuntimeHandle`。

**具体工作**
1. 新建 `packages/backend/src/process-runtime/host-runtime.ts`。
2. `export class HostRuntime implements ProcessRuntime`：
   - `spawn(spec: LaunchSpec): Promise<RuntimeHandle>`：
     - 若 `spec.runtime !== 'host'` 抛 `Error(\`HostRuntime cannot handle runtime=\${spec.runtime}\`)`。
     - `stdio` 根据 `spec.stdio` 解析，默认 `['pipe', 'pipe', 'inherit']`。
     - 调 `child_process.spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio })`。
     - 用 `node:stream` 的 `Writable.toWeb(child.stdin!)` / `Readable.toWeb(child.stdout!)` 适配 Web Streams（语义对齐 `driver.ts:96-97`）。
     - 返回的 `RuntimeHandle` 里：
       - `pid = child.pid!`
       - `stdin / stdout` 指向上一步的 Web Streams
       - `onExit(cb)`：包装 `child.once('exit', ...)`；重复注册抛错 `'onExit already registered'`。
       - `kill(signal?)`：SIGTERM → 2s → SIGKILL；幂等（用内部 boolean flag 拦截重复调用）；返回 Promise，在 `child.once('exit')` 后 resolve。
   - `isAvailable(cliType)`：在 PATH 下查找该命令是否存在。实现方式可二选一 —— (a) 扫 `process.env.PATH` 目录下是否有可执行文件；(b) 用 `which`/`where` 命令探测并捕获异常。结果返 `true` / `false`。
   - `destroy()`：本实现无资源（没有 docker client），空实现即可，返 `Promise.resolve()`。
3. 新建 `__tests__/host-runtime.test.ts`，按 REGRESSION.md §1 逐条实现。
4. 新建 / 追加 `README.md` 的 "HostRuntime" 小节：一句话说明 + 3-5 行使用示例（new HostRuntime().spawn(...).then(h => h.stdin.getWriter()...）+ 注意事项（单次 onExit、kill 幂等、Web Streams 转换）。

**禁止事项**
- 不 import 业务代码（driver.ts / pty/* / bus / db / mcp-store 等，一律禁止）。
- 不依赖全局单例；`HostRuntime` 必须能通过 `new HostRuntime()` 构造出多个独立实例互不影响。
- 单文件 ≤ 200 行。
- 不 mock 测试。测试用真实子进程（Node 自身可用）。

### 模块 C — DockerRuntime stub

**职责**：占位骨架，防止未来误用；接口形状已就位，具体实现留给 Stage 4。

**具体工作**
1. 新建 `packages/backend/src/process-runtime/docker-runtime.ts`：
   ```typescript
   import type { ProcessRuntime, LaunchSpec, RuntimeHandle } from './types.js';
   export class DockerRuntime implements ProcessRuntime {
     async spawn(_spec: LaunchSpec): Promise<RuntimeHandle> {
       throw new Error('DockerRuntime not implemented (reserved for Stage 4)');
     }
     async isAvailable(_cliType: string): Promise<boolean> { return false; }
     async destroy(): Promise<void> { /* no-op */ }
   }
   ```
2. 新建 `__tests__/docker-runtime.test.ts`，按 REGRESSION.md §1 的 smoke 用例实现。
3. 新建 / 追加 `README.md` 的 "DockerRuntime" 小节：一句话说明 + 警告（Stage 1 不可用）+ Stage 4 将填的实现要点（docker run -i --rm、attach multiplex 拆流、pid=container id、docker stop -t 2）。

**禁止事项**
- 不提前实现任何 Docker 逻辑。本 Stage 就是要它抛错，防止被误当可用。
- 不 import `dockerode` / `child_process` / 任何真实 docker 能力。
- 不 import 业务代码。

---

## 4. 开发须知

### 4.1 每个模块的 README.md 必须包含

Stage 1 三个非业务模块共享同一份 `packages/backend/src/process-runtime/README.md`，每个模块负责贡献自己那个小节。总 README 结构：

```markdown
# process-runtime

<本模块一句话是什么>

## 契约
<引用 types.ts 中的 5 个类型 + 1 个守卫，简要说明>

## HostRuntime
- 一句话说明
- 3-5 行使用示例
- 注意事项 / 边界行为

## DockerRuntime
- 一句话说明
- Stage 1 不可用警告
- Stage 4 将填的实现要点

## 类型守卫 isLaunchSpec
- 用法
- 校验规则一句话
```

**非业务模块 README 不需要时序图 / 竞态分析 / 错误传播路径**（那是业务模块的要求，见 WORKFLOW.md §3）。

### 4.2 模块之间的接口约定

- **共享代码只能是类型**：B/C 只允许 `import type { ... } from './types.js'` 或 `import { isLaunchSpec }`。不允许 B import C 或 C import B。
- **Web Streams 语义对齐**：`stdin` / `stdout` 使用 Node 原生的 `Writable.toWeb` / `Readable.toWeb`，不要自造 stream 包装。调用方拿到的 ReadableStream 用 `.getReader()` 读，WritableStream 用 `.getWriter().write(uint8)` 写。
- **kill 的宽限语义**：2000ms。不要改成别的数字（和当前 `driver.ts:135` 一致，避免回归期望偏移）。
- **onExit 的回调参数**：`(code: number | null, signal: string | null)`。正常退出 `(0, null)`；被 SIGTERM 杀 `(null, 'SIGTERM')`；被 SIGKILL 杀 `(null, 'SIGKILL')`。不要自造 code/signal 同时非 null 的情况。

### 4.3 禁止事项（全局）

1. **不改现有业务代码**：本 Stage 严禁动 `driver.ts`、`pty/manager.ts`、`agent-driver/types.ts` 的现有 `SpawnSpec`、任何 subscribers、任何路由层。这些归 Stage 2+。
2. **不 mock 测试**：遵循项目红线。HostRuntime 的测试用 Node 真子进程；DockerRuntime 的 smoke 测试不需要 Docker（只验抛错）。
3. **不引入新依赖**：`child_process` / `node:stream` / `node:util` 都是 Node 内置。不允许新增 npm 包。DockerRuntime stub 也不要引入 `dockerode`。
4. **单文件 ≤ 200 行**：若 host-runtime.ts 快到，优先把 kill 宽限 / Web Stream 适配 / onExit 单次注册 拆成内部辅助函数放同文件；如整体超 200 行，拆 `host-runtime-kill.ts` 等内部辅助（不对外 export）。
5. **非业务模块不依赖全局单例**：不 `import { bus } from ...`、不 `import { db } from ...`。构造函数里不读 `process.env`（`LaunchSpec.env` 已经是调用方算好的）。
6. **index.ts 是唯一对外入口**：外部模块（Stage 2 开始才会用到）只通过 `packages/backend/src/process-runtime/index.ts` 引用；其他文件不对外 re-export。

### 4.4 合入顺序

1. **先合模块 A**（types + index + launch-spec.test）——契约落盘后 tsc 能解析 B/C 的 import。
2. **再合模块 B、C**（可同时合）。
3. 合入前每个模块本地 `pnpm --filter backend test` 通过。
4. 全量合入后再由测试员按 REGRESSION.md 过一遍。

### 4.5 契约变更流程

若开发过程中发现 §1 契约有问题（例如 `pid` 不应该是联合类型），**不允许在模块代码里绕过**。停下来 SendMessage 给 leader，由架构师评估后更新本文档再继续。
