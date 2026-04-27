# Stage 1 — 回归测试清单

> 依据：`packages/backend/docs/phase-sandbox-acp/stage-1-process-runtime.md` §9、`TASK-LIST.md` §1 契约。
> 执行者：测试员（与开发员不是同一人，遵循 WORKFLOW.md §6）。
> 运行方式：`pnpm --filter backend test process-runtime`（或直接 `vitest run packages/backend/src/process-runtime`）。
> 测试库：项目默认 Vitest，不 mock 任何依赖。

---

## 1. 单元测试（模块级）

### 1.1 模块 A — LaunchSpec 类型守卫（`launch-spec.test.ts`）

| # | 测试项 | 验证什么 | 预期结果 | 通过 |
|---|--------|---------|---------|------|
| A1 | `isLaunchSpec(完整合法 LaunchSpec)` | 正例：runtime/command/args/env/cwd 全部合法 | 返回 `true` | ⬜ |
| A2 | `isLaunchSpec(null)` | null 输入 | 返回 `false` | ⬜ |
| A3 | `isLaunchSpec(undefined)` | undefined 输入 | 返回 `false` | ⬜ |
| A4 | `isLaunchSpec('string')` | 非 object 输入 | 返回 `false` | ⬜ |
| A5 | `isLaunchSpec({runtime:'k8s', ...})` | runtime 不是 'host' / 'docker' | 返回 `false` | ⬜ |
| A6 | `isLaunchSpec({command:'', ...})` | command 空字符串 | 返回 `false` | ⬜ |
| A7 | `isLaunchSpec({args:[1,2], ...})` | args 非字符串数组 | 返回 `false` | ⬜ |
| A8 | `isLaunchSpec({env:{FOO:42}, ...})` | env 的 value 非字符串 | 返回 `false` | ⬜ |
| A9 | `isLaunchSpec({cwd:'', ...})` | cwd 空字符串 | 返回 `false` | ⬜ |
| A10 | `isLaunchSpec({..., stdio:{stdin:'weird'}})` | stdio.stdin 非 `pipe/inherit/ignore` | 返回 `false` | ⬜ |
| A11 | `isLaunchSpec(缺 runtime)` | 必填字段缺失 | 返回 `false` | ⬜ |
| A12 | `isLaunchSpec(缺 command)` | 必填字段缺失 | 返回 `false` | ⬜ |
| A13 | `isLaunchSpec(缺 args)` | 必填字段缺失 | 返回 `false` | ⬜ |
| A14 | `isLaunchSpec(缺 env)` | 必填字段缺失 | 返回 `false` | ⬜ |
| A15 | `isLaunchSpec(缺 cwd)` | 必填字段缺失 | 返回 `false` | ⬜ |
| A16 | `isLaunchSpec({..., stdio: undefined})` | stdio 缺省（合法）| 返回 `true` | ⬜ |

### 1.2 模块 B — HostRuntime 契约测试（`host-runtime.test.ts`）

所有用例使用真实 Node 子进程（`command: 'node'`），不 mock `child_process`。每个测试需设置合理超时（5s 足够），并在 afterEach 保证进程已回收。

| # | 测试项 | 验证什么 | 预期结果 | 通过 |
|---|--------|---------|---------|------|
| B1 | `spawn echo 能拿到 stdout` | 启动 `node -e "process.stdout.write('hello')"`，读 `handle.stdout` | 读到 `"hello"` 字节 | ⬜ |
| B2 | `stdin 写入能被子进程读到` | 启动 `node -e "process.stdin.on('data', d => process.stdout.write(d))"`，往 stdin 写 `"ping"` | 从 stdout 读到 `"ping"` | ⬜ |
| B3 | `onExit 正常退出 code=0` | 启动 `node -e "process.exit(0)"` | onExit 回调 `(0, null)` | ⬜ |
| B4 | `onExit 异常退出 code=2` | 启动 `node -e "process.exit(2)"` | onExit 回调 `(2, null)` | ⬜ |
| B5 | `onExit 重复注册抛错` | 对同一 handle 连续调 `onExit(cb1)` + `onExit(cb2)` | 第二次调用抛错 `'onExit already registered'` | ⬜ |
| B6 | `kill SIGTERM 能杀掉可优雅退出的进程` | 启动长驻进程 `node -e "setInterval(()=>{},1000)"`，调 `await handle.kill()` | onExit 回调触发，signal 为 `'SIGTERM'` 或 code 为 0 | ⬜ |
| B7 | `kill 对忽略 SIGTERM 的进程 2s 内升级 SIGKILL` | 启动忽略 SIGTERM 的进程（`node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"`），调 kill | 2~3s 内 onExit 触发，signal === `'SIGKILL'` | ⬜ |
| B8 | `kill 幂等` | 同一 handle 连续 `kill()` 两次 | 第二次不抛错，onExit 只触发一次，两次 await 都 resolve | ⬜ |
| B9 | `isAvailable('node')` | PATH 上有 node | 返回 `true` | ⬜ |
| B10 | `isAvailable('definitely-not-a-real-cli-xyz')` | PATH 上一定没有 | 返回 `false` | ⬜ |
| B11 | `env 透传` | `spawn node -e "process.stdout.write(process.env.FOO||'nope')"`, env 传 `{ FOO:'bar', PATH: process.env.PATH }` | stdout 读到 `"bar"` | ⬜ |
| B12 | `cwd 生效` | `spawn node -e "process.stdout.write(process.cwd())"`, cwd 传 `os.tmpdir()` | stdout 内容等于 os.tmpdir() 真实路径 | ⬜ |
| B13 | `spec.runtime 校验` | 传 `runtime:'docker'` 给 HostRuntime.spawn | 抛错，错误信息包含 `HostRuntime` 和 `docker` | ⬜ |
| B14 | `stdio.stderr:'pipe' 配置可通过` | 传 `stdio:{stderr:'pipe'}` 的 spec | spawn 成功（不抛错）；子进程可正常启停 | ⬜ |
| B15 | `destroy 幂等且不抛` | 对 HostRuntime 实例连调 `destroy()` 两次 | 两次都 resolve，不抛错 | ⬜ |
| B16 | `pid 是正整数` | spawn 成功后读 `handle.pid` | `typeof pid === 'number' && pid > 0` | ⬜ |
| B17 | `多实例互不影响` | 同一 HostRuntime 实例 spawn 两个进程，各写各读 | 两个 handle 的 stdout 互不串数据 | ⬜ |

### 1.3 模块 C — DockerRuntime stub（`docker-runtime.test.ts`）

| # | 测试项 | 验证什么 | 预期结果 | 通过 |
|---|--------|---------|---------|------|
| C1 | `spawn 抛 not implemented` | `await new DockerRuntime().spawn(anySpec)` | 抛错，错误信息包含 `'not implemented'` 和 `'Stage 4'` | ⬜ |
| C2 | `isAvailable 返 false` | `await new DockerRuntime().isAvailable('anything')` | 返回 `false` | ⬜ |
| C3 | `destroy 不抛错` | `await new DockerRuntime().destroy()` | 正常 resolve | ⬜ |

---

## 2. 集成测试

> Stage 1 的特点：新增纯抽象层，**不串接任何业务调用方**，所以没有跨模块集成测试。
> HostRuntime 的"真子进程 + 真管道"本身就是最小集成场景，已在 §1.2 覆盖。

| # | 测试项 | 验证什么 | 预期结果 | 通过 |
|---|--------|---------|---------|------|
| I1 | `index.ts re-export 完整` | `import { HostRuntime, DockerRuntime, isLaunchSpec } from '.../process-runtime'` 以及 `import type { LaunchSpec, RuntimeHandle, ProcessRuntime, StdioConfig, StdioMode } from '.../process-runtime'` | 全部解析成功，tsc 无报错 | ⬜ |
| I2 | `HostRuntime 端到端最小链路` | 用 HostRuntime 启动 `node -e "process.stdin.on('data',d=>process.stdout.write(Buffer.concat([Buffer.from('echo:'),d])))"`，往 stdin 写 `"ok"`，读 stdout，再 `kill()` | stdout 读到 `"echo:ok"`；kill 后 onExit 触发，进程不残留 | ⬜ |

---

## 3. 回归验证（确保没破坏现有功能）

> 核心原则：Stage 1 **只新增文件**，`driver.ts` 和 `pty/manager.ts` 零改动。回归重点是**验证没有动**，而不是验证行为。

| # | 测试项 | 验证什么 | 预期结果 | 通过 |
|---|--------|---------|---------|------|
| R1 | 现有后端全量测试通过 | `pnpm --filter backend test`（不含新加用例也要过） | 所有既有测试全绿 | ⬜ |
| R2 | backend tsc 无新增报错 | `pnpm --filter backend typecheck` | 0 error，0 新增 warning | ⬜ |
| R3 | `driver.ts` 文件未改动 | `git diff main -- packages/backend/src/agent-driver/driver.ts` | 无输出（空 diff） | ⬜ |
| R4 | `pty/manager.ts` 文件未改动 | `git diff main -- packages/backend/src/pty/manager.ts` | 无输出（空 diff） | ⬜ |
| R5 | `agent-driver/types.ts` 文件未改动 | `git diff main -- packages/backend/src/agent-driver/types.ts` | 无输出（空 diff） | ⬜ |
| R6 | backend 运行时依赖未新增 | `git diff main -- packages/backend/package.json` | 无输出（空 diff） | ⬜ |
| R7 | 启动 backend 主 Agent 链路冒烟 | 本地按常规方式启动 backend，用既有前端或 curl 触发一次主 Agent 对话 | 行为与 Stage 1 开始前一致，`child_process.spawn` 路径仍正常 | ⬜ |
| R8 | 启动后端成员 PTY 冒烟 | 本地创建一个成员实例（走原 PtyManager 路径） | PTY spawn 正常，ready 探测正常，kill 正常 | ⬜ |

---

## 4. 约束性检查（架构红线）

| # | 检查项 | 如何验证 | 预期 | 通过 |
|---|--------|---------|------|------|
| X1 | `process-runtime/` 不 import 业务代码 | `grep -rn "from '\.\./" packages/backend/src/process-runtime/` | 命中结果为空，或只命中 `./types.js` / `./host-runtime.js` / `./docker-runtime.js` 这种同模块内的相对导入 | ⬜ |
| X2 | `process-runtime/` 不依赖 bus/db/config | `grep -rEn "from '\.\./(bus\|db\|config\|mcp-store\|domain)" packages/backend/src/process-runtime/` | 无命中 | ⬜ |
| X3 | 单文件 ≤ 200 行 | `wc -l packages/backend/src/process-runtime/*.ts` | 每个文件 ≤ 200 行 | ⬜ |
| X4 | 未引入 npm 新依赖 | 对比 `packages/backend/package.json` 的 dependencies/devDependencies | 完全一致 | ⬜ |
| X5 | 未 mock 子进程 | `grep -rEn "vi\.mock\('child_process" packages/backend/src/process-runtime/__tests__/` | 无命中 | ⬜ |
| X6 | `DockerRuntime` stub 没有真实 docker 调用 | `grep -rEn "dockerode\|docker run\|spawn.*'docker'" packages/backend/src/process-runtime/docker-runtime.ts` | 无命中 | ⬜ |
| X7 | README.md 存在且覆盖三个模块 | 打开 `packages/backend/src/process-runtime/README.md` | 含 `HostRuntime` / `DockerRuntime` / `isLaunchSpec` 三个小节 | ⬜ |

---

## 5. 测试员交付

完成全部条目后，测试员在本文末尾追加一节：

```markdown
## 6. 测试执行报告

- 执行日期：YYYY-MM-DD
- 执行人：<agent 名>
- 总用例：<数>
- 通过：<数>
- 失败清单：<#编号 + 一句话症状>  或  "无"
- 缺陷单：<指向 bug 修复员的 SendMessage 摘要>  或  "无"
- 结论：✅ Stage 1 通过 / ❌ 待修复后重测
```

失败任意一条 → 不准宣告 Stage 1 完成。由 leader 派修复员按 WORKFLOW.md §4 进入循环。
