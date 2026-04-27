# Stage 4 — 内置 MCP HTTP 化 + DockerRuntime · 模块清单

> 架构师：已拆完，撤。
> 设计文档：`packages/backend/docs/phase-sandbox-acp/stage-4-mcp-http.md`
> 工作流：`packages/backend/docs/phase-sandbox-acp/WORKFLOW.md`

---

## W0 · 前置任务：server.ts 拆包（必做，先于 Wave 1）

**背景：** `packages/backend/src/server.ts` 当前 **423 行**，远超 200 行红线。Stage 4 W2-C 还要在 `startServer()` 里插 `startMcpHttpServer()`，Stage 5 还要加 sandbox/policy 开关 —— 不拆就是灾难。**W0 必须在任何 Wave 1 / Wave 2 任务动手之前完成**（W2-C 直接依赖 W0 的新文件位置）。

### W0 范围

**目录结构：**

```
packages/backend/src/http/
├── server.ts              入口（createServer + startServer + reconcile）
├── http-utils.ts          readBody + CORS 头 + jsonResponse
├── router.ts              主 route() 调度器
└── routes/
    ├── roster.routes.ts        ROSTER_PREFIX + ROSTER_SEARCH 分发
    ├── teams.routes.ts         TEAMS_PREFIX 分发
    ├── instances.routes.ts     INSTANCES_PREFIX 分发
    ├── templates.routes.ts     PREFIX（role-templates）分发
    ├── primary-agent.routes.ts PRIMARY_AGENT_* 分发
    ├── cli.routes.ts           CLI_PREFIX + CLI_REFRESH 分发
    ├── sessions.routes.ts      SESSIONS_REGISTER 分发
    └── mcp-tools.routes.ts     MCP_TOOLS_SEARCH + routeMcpStore 透传
```

**每个文件估算行数（全部 ≤ 80 行，远低于 200 红线）：**

| 文件 | 行数估算 | 职责 |
|---|---|---|
| `http/server.ts` | ~80 | `createServer()` + `startServer()` + `reconcileStaleInstances()` + shutdown 钩子 |
| `http/http-utils.ts` | ~40 | `readBody()` / `CORS_HEADERS` / `jsonResponse()` 导出给所有 routes 复用 |
| `http/router.ts` | ~50 | 主 `route(req)`，按 pathname 前缀派发到各 `routes/*.ts` 的 `handle(...)` 函数 |
| `http/routes/roster.routes.ts` | ~45 | 导出 `handleRosterRoute(req, pathname, method, query)`，含 `/api/roster` + `/api/roster/search` + `/api/roster/:id` + `/api/roster/:id/alias` |
| `http/routes/teams.routes.ts` | ~50 | 导出 `handleTeamsRoute(...)`，含 by-instance、disband、members |
| `http/routes/instances.routes.ts` | ~40 | 导出 `handleInstancesRoute(...)`，含 activate、request-offline（X-Role-Instance-Id header 读取） |
| `http/routes/templates.routes.ts` | ~35 | 导出 `handleTemplatesRoute(...)` |
| `http/routes/primary-agent.routes.ts` | ~30 | config / start / stop / get |
| `http/routes/cli.routes.ts` | ~20 | list / refresh |
| `http/routes/sessions.routes.ts` | ~15 | register |
| `http/routes/mcp-tools.routes.ts` | ~25 | search + routeMcpStore 透传 |

**拆包规则：**

1. 老路径 `packages/backend/src/server.ts` **删除**，入口改为 `packages/backend/src/http/server.ts`。`package.json` 的 `bin` / `main` / `exports` 若指向老路径同步改。
2. 各 `routes/*.ts` 导出单一函数 `handleXxxRoute(req, pathname, method, query): Promise<ApiResponse | null>`，返回 `null` 表示"不是我的路径，交给下一个 router"。
3. `router.ts` 按 pathname 前缀做第一轮筛选（`if (pathname === X) return handleX(...)`），命中一个返回一个；全部未命中返回 `{ status: 404, ... }`。
4. `panel.html` 服务代码（`servePanelHtml`）留在 `http/server.ts`，不拆（就 13 行）。
5. 常量（`DEFAULT_PORT` / `PREFIX` / `INSTANCES_PREFIX` 等）下沉到对应 route 文件里，**不要**集中在 router.ts。

### W0 交付清单

- `packages/backend/src/http/server.ts` + `http-utils.ts` + `router.ts` + 8 个 `routes/*.ts`
- 删除老 `packages/backend/src/server.ts`
- 更新 `packages/backend/package.json` 的入口指向
- 更新 `__tests__/` 里引用 `server.ts` 的路径
- `packages/backend/src/http/README.md` — 说明目录结构 + 如何新增一条路由（给 Stage 4 W2-C / Stage 5 留接入指引）
- 单测：原 server 集成测全绿；无需新增单独 routes 单测（路由层纯派发，handler 测试已在 `api/panel/*` 层覆盖）

### W0 完成判据

- `wc -l packages/backend/src/http/*.ts packages/backend/src/http/routes/*.ts` 全部 ≤ 200
- `pnpm tsc --noEmit` 全仓绿
- 启动 backend，老 curl 回归：`GET /api/roster` / `GET /api/role-templates` / `POST /api/role-instances/:id/activate` 全部行为不变
- W2-C 的 `startMcpHttpServer()` 接入点改为 `packages/backend/src/http/server.ts` 的 `startServer()`

### W0 负责人

**pending** — leader 先派 W0，W0 合并后再放开 Wave 1。

---

## 0. 前置与偏差更正

### 前置依赖（硬依赖）

Stage 4 的 `DockerRuntime` 依赖 Stage 1 交付的 `ProcessRuntime` / `LaunchSpec` / `RuntimeHandle` 抽象（`packages/backend/src/process-runtime/types.ts`）。

- **Wave 1 启动条件：** Stage 1 的 `process-runtime/types.ts` 必须已落盘。若 Stage 1 仍在进行，`docker-runtime.ts` 开发者**先不动手**，等 Stage 1 的 `types.ts` 合入后再进场。
- 其余 Wave 1 模块（`mcp-http/*`、`mcp/server` 抽包、`searchtools/server` 抽包、Dockerfile）**无** Stage 1 依赖，立即可并行。

### 设计文档偏差（已确认的实际口径）

设计文档 §3.2 写 "V2 :58580 / MCP HTTP :58590"，**实际** backend V2 HTTP 默认端口就是 **58590**（见 `packages/backend/src/server.ts:60`）。本 Stage 统一采用：

| listener | 端口 | env 覆盖 |
|---|---|---|
| V2 HTTP（既有） | 58590 | `V2_PORT` |
| MCP HTTP（新增） | **58591** | `MCP_HTTP_PORT` |

所有接口契约、测试命令、文档示例里**不要**再出现 58580/58590 冲突。

### `mcp-manager.ts:43-44` 的 `MTEAM_MCP_ENTRY` / `SEARCHTOOLS_MCP_ENTRY` 常量

改造后 `resolve()` 不再返回 `process.execPath` / `command`。这两个常量**在 `mcp-manager.ts` 里删除**，过渡期留给 `packages/*` 内部的 stdio 脚本（如果有 pnpm 脚本直启）自己处理——Stage 4 不再维护 stdio 子进程 spawn 路径。

---

## 1. 接口契约（所有模块遵守）

### 1.1 `CommLike`（新增）

位置：`packages/backend/src/mcp/comm-like.ts`（Wave 1 · mcp/server 拆包任务顺带落盘）

```ts
export interface CommLike {
  ensureReady(): Promise<void>;
  send(opts: { to: string; payload: Record<string, unknown> }): Promise<void>;
  close(): void;
}
```

- 现有 `CommClient`（`mcp/comm-client.ts`）天然满足——**在 `CommClient` class 顶上加一行 `implements CommLike`** 即可，签名已对齐。
- `InProcessComm`（Wave 1 · `mcp-http/in-process-comm.ts`）实现同一接口，绕过 unix socket 直接调 `commBus` / `CommServer.router`。

### 1.2 `ResolvedMcpSpec`（新增）

位置：`packages/backend/src/mcp-store/types.ts`

```ts
export type ResolvedMcpSpec =
  | {
      kind: 'builtin';
      name: 'mteam' | 'searchTools';
      env: Record<string, string>;          // ROLE_INSTANCE_ID / V2_SERVER_URL / IS_LEADER 等
      visibility: { surface: string[] | '*'; search: string[] | '*' };
    }
  | {
      kind: 'user-stdio';
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
    };

export interface ResolvedMcpSet {
  specs: ResolvedMcpSpec[];
  skipped: string[];
}
```

`mcp-manager.resolve()` 的返回类型从旧 `ResolvedMcpSet`（含 `configJson`）改为新版本。旧 `configJson` 字段**删除**，不维护双版本。

### 1.3 `startMcpHttpServer()`（新增）

位置：`packages/backend/src/mcp-http/index.ts`

```ts
export interface McpHttpOptions {
  port?: number;          // 默认读 MCP_HTTP_PORT，再默认 58591
  host?: string;          // 默认 '127.0.0.1'，不要绑 0.0.0.0
  hubUrl: string;         // 透传给 mteam env（内部自调 V2 API 时用）
  commRouter: CommRouter; // 从 CommServer.router 传入，供 InProcessComm 用
  bus?: EventBus;         // 可选，默认 default bus
}

export interface McpHttpHandle {
  url: string;            // 例如 http://127.0.0.1:58591
  close: () => Promise<void>;
}

export async function startMcpHttpServer(opts: McpHttpOptions): Promise<McpHttpHandle>;
```

路由：
- `POST /mcp/mteam` → `StreamableHTTPServerTransport` 挂到 `createMteamServer(env, comm)`
- `POST /mcp/searchTools` → `StreamableHTTPServerTransport` 挂到 `createSearchToolsServer(env)`

session 策略：`sessionIdGenerator: () => randomUUID()`（stateful）。

请求头规范（容器里 agent 发请求时必须带，launch-spec-builder 在 `McpServerSpec.headers` 里配）：
- `X-Role-Instance-Id`：必填
- `X-Is-Leader`：`'1'` | `'0'`（mteam only）
- `X-Tool-Visibility`：`JSON.stringify(visibility)`（mteam only，空 `{}` 表示 `*`）

listener 从 header 构造 `MteamEnv`，再用 `InProcessComm` 新建 `Server` 实例绑该 session。

### 1.4 `createMteamServer` / `createSearchToolsServer`（从现有文件抽出）

位置：保持在原文件 `packages/backend/src/mcp/server.ts` / `searchtools/server.ts`

```ts
// mcp/server.ts
export function createMteamServer(env: MteamEnv, comm: CommLike): Server;
export async function runMteamServerStdio(): Promise<void>;  // 原 runMteamServer 改名

// searchtools/server.ts
export function createSearchToolsServer(env: SearchEnv): Server;
export async function runSearchToolsServerStdio(): Promise<void>;
```

- `createXxxServer` 只构造 `Server` + 注册 handler，**不** `server.connect()`，**不** 注册 `SIGINT/SIGTERM/stdin.close`。
- `runXxxServerStdio` 负责 env 读取、`new StdioServerTransport()`、signal 清理——供 `mcp/index.ts` / `searchtools/index.ts` 继续调用（stdio 入口兼容保留）。

### 1.5 `launchSpecBuilder`（新增 · Wave 2）

位置：`packages/backend/src/primary-agent/launch-spec-builder.ts`

```ts
export interface LaunchSpecBuilderInput {
  resolved: ResolvedMcpSet;
  runtimeKind: 'host' | 'docker';
  instanceId: string;
  mcpHttpBaseForHost: string;         // 'http://localhost:58591'
  mcpHttpBaseForDocker: string;       // 'http://host.docker.internal:58591'
}

export function buildMcpServerSpecs(input: LaunchSpecBuilderInput): McpServerSpec[];
```

分流规则见设计文档 §6.2。注意：
- 本 Stage 统一**两种 runtime 下内置 MCP 都走 HTTP**（设计文档 §6.2 推荐的一步到位）。host 模式用 `mcpHttpBaseForHost`，docker 用 `mcpHttpBaseForDocker`。
- `user-stdio` 的 runtime=docker 分支，Stage 4 **原样透传 stdio**（Stage 5 再补 volume 挂载）。
- **`runtimeKind` 与 `LaunchSpec.runtime` 的映射**：`runtimeKind` 是 builder 的输入（从 DB `row.runtimeKind` / `instance.runtimeKind` 读），*不是* `LaunchSpec` 的字段。builder 的调用方（`primary-agent` / `member-agent` 的 start 路径）在构造 `LaunchSpec` 时，**必须原样赋值**：`spec.runtime = runtimeKind`。两者字面值一致（`'host' | 'docker'`），桥逻辑仅此一行。接口以 [`INTERFACE-CONTRACTS.md`](../INTERFACE-CONTRACTS.md) §3 为准 —— `LaunchSpec.runtime` 字段必填，不能省略或用其他字段名替代。

---

## 2. Wave 1 · 非业务模块（并行）

每个模块单文件 ≤ 200 行；测试不 mock bus / db / docker；产出 `README.md`。

### W1-A · `mcp/` 和 `searchtools/` 的 server 拆包

**范围：**
- 修改 `packages/backend/src/mcp/server.ts` — 拆 `createMteamServer` + `runMteamServerStdio`，把 `CommClient` 收窄为 `CommLike`
- 新增 `packages/backend/src/mcp/comm-like.ts` — 定义 `CommLike` 接口（§1.1）
- 修改 `packages/backend/src/mcp/comm-client.ts` — 加 `implements CommLike`（零行为改动）
- 修改 `packages/backend/src/searchtools/server.ts` — 拆 `createSearchToolsServer` + `runSearchToolsServerStdio`
- 修改 `packages/backend/src/mcp/index.ts` / `searchtools/index.ts` — 调用新的 `runXxxServerStdio`
- 测试：`mcp/server.test.ts` 覆盖 `createMteamServer` 返回的 Server 能响应 `ListTools` / `CallTool`（用 mock `CommLike`，这是业务无关的契约测，允许 mock **接口**；不许 mock bus/db）

**README 要点：** 两个入口（stdio / server 构造）的区别、`CommLike` 注入点、`visibleTools(isLeader)` 语义。

### W1-B · `mcp-http/` HTTP listener 骨架 + InProcessComm

**范围：**
- 新增 `packages/backend/src/mcp-http/index.ts` — `startMcpHttpServer()`（§1.3）
- 新增 `packages/backend/src/mcp-http/mteam-handler.ts` — 接收 HTTP 请求头、构造 `MteamEnv` + `InProcessComm`、new `Server` + `StreamableHTTPServerTransport`
- 新增 `packages/backend/src/mcp-http/searchtools-handler.ts` — 同上，但不需 comm
- 新增 `packages/backend/src/mcp-http/in-process-comm.ts` — 实现 `CommLike`，`send()` 直接调 `commRouter.route(envelope)`（参考 `CommServer.router` 的形状），`ensureReady()` 立刻 resolve
- 测试：`mcp-http/index.test.ts` 用 MCP SDK 的 client side 跑 ListTools / CallTool 往返（**真 bus、真 listener、真 HTTP**），断言 `bus.on('comm.send')` 能收到事件

**README 要点：** 请求头契约、session 生命周期、host=127.0.0.1 不能绑 0.0.0.0 的原因、InProcessComm 与 stdio CommClient 的等价性/差异。

**依赖：** W1-A 的 `createMteamServer` / `createSearchToolsServer` 导出（建议两个开发者提前对齐文件边界，不互相等；W1-A 发 merge 请求时 W1-B 可用 stub 先跑）。

### W1-C · `process-runtime/docker-runtime.ts`

**前置：** Stage 1 的 `process-runtime/types.ts` 必须先合入（`ProcessRuntime` / `LaunchSpec` / `RuntimeHandle` 定义）。

**范围：**
- 新增 `packages/backend/src/process-runtime/docker-runtime.ts` — `createDockerRuntime(cfg: DockerRuntimeConfig): ProcessRuntime` 实现（设计文档 §4.2-4.4）
- 必须默认加 `--cap-drop ALL`、`--security-opt no-new-privileges`、`--rm`、`-i`、`--network <cfg.network>`
- 必须支持 Linux 自动加 `--add-host=host.docker.internal:host-gateway`（通过 `os.platform() === 'linux'` 探测）
- 测试：`docker-runtime.test.ts`
  - spawn `node:20-slim` 跑 `node -e "process.stdin.pipe(process.stdout)"`，往 stdin 写 `hello\n`，断言 stdout 读到 `hello\n`
  - `handle.kill('SIGTERM')` 后 2s 内 `onExit` 触发
  - 镜像不存在时 `onExit` 收非零 code
  - **不 mock docker CLI**；跑测试要求宿主 daemon 可用（package.json 里标注 `@requires-docker` 或在 README 里写明）

**README 要点：** 最小权限默认值、extraDockerArgs 的用途（Stage 5 hook 点）、Linux `host-gateway` 探测、`--rm` 清理语义、kill→docker→容器 PID 1 的信号传递链。

### W1-D · `docker/agent-claude.Dockerfile`

**范围：**
- 新增 `docker/agent-claude.Dockerfile`（设计文档 §4.1）
- 基础镜像 `node:20-slim`，预装 `@anthropic-ai/claude-acp`（版本从 `packages/backend/package.json` 的 dep 里 pin 出来）
- ENTRYPOINT 直接是 `claude-acp` 可执行文件
- 不 `COPY` backend 代码
- 交付物：Dockerfile 本身 + `docker/README.md`（build 命令、镜像命名规范 `mteam/agent-claude:<tag>`、测试镜像跑通指令）
- **不需要单测文件**；verification 通过 `docker build -f docker/agent-claude.Dockerfile -t mteam/agent-claude:dev .` 能出镜像、`docker run --rm -i mteam/agent-claude:dev <<< '{}'` 能进 claude-acp

**README 要点：** 版本 pin 来源、tag 规范、后续 codex 对称做法、为什么不 COPY backend 代码。

### Wave 1 汇总

| 模块 | 交付物 | 单文件 ≤200 行 | 依赖 |
|---|---|---|---|
| W1-A | `mcp/server.ts` 重构 + `mcp/comm-like.ts` + `searchtools/server.ts` 重构 + `*.test.ts` + README | 是 | 无 |
| W1-B | `mcp-http/{index,mteam-handler,searchtools-handler,in-process-comm}.ts` + `index.test.ts` + README | 是 | W1-A 的 `createXxxServer` 导出（接口先锁） |
| W1-C | `process-runtime/docker-runtime.ts` + `.test.ts` + README | 是 | Stage 1 的 `process-runtime/types.ts` |
| W1-D | `docker/agent-claude.Dockerfile` + `docker/README.md` | - | 无 |

---

## 3. Wave 2 · 业务模块（胶水层）

Wave 1 **全部**交付后才启动 Wave 2。每个模块 README 必须含时序图 + 竞态分析 + 错误传播路径。

### W2-A · `mcp-manager.resolve()` 改造

**范围：**
- 修改 `packages/backend/src/mcp-store/mcp-manager.ts`
  - `resolve()` 返回新 `ResolvedMcpSet`（§1.2），不再塞 `configJson`
  - 删除 `MTEAM_MCP_ENTRY` / `SEARCHTOOLS_MCP_ENTRY` 常量与 `process.execPath` 相关代码
  - `__builtin__` 分支吐 `{ kind: 'builtin', name, env, visibility }`
  - 非 builtin 吐 `{ kind: 'user-stdio', ... }`
  - searchTools 无条件注入 `{ kind: 'builtin', name: 'searchTools', ... }`
- 修改 `packages/backend/src/mcp-store/types.ts` — 增 `ResolvedMcpSpec` / `ResolvedMcpSet` 新定义，旧 `ResolvedMcpSet` 覆盖
- 更新/新增 `mcp-manager.test.ts` — 用真实 `McpConfig` 快照，断言产物形状

**README 要点：** 新旧产物形状的映射表、为什么去掉 `configJson`、visibility 默认值处理、`skipped` 语义未变。

**风险：** `mcp-manager.resolve()` 的老消费者是 `driver-config.ts` 的 `Object.entries(resolved.configJson.mcpServers)`（`driver-config.ts:50`）——必须跟 W2-B 原子迁移，否则编译失败。

### W2-B · `primary-agent/launch-spec-builder.ts` 新增 + primary/member driver-config 统一改造

**范围：**
- 新增 `packages/backend/src/primary-agent/launch-spec-builder.ts` — `buildMcpServerSpecs()`（§1.5）
- 修改 `packages/backend/src/primary-agent/driver-config.ts`
  - 不再手拼 `McpServerSpec[]`（删 `driver-config.ts:50-58`）
  - `buildDriverConfig()` 读 `row.runtimeKind`（需要确认 `PrimaryAgentRow` 是否有这个字段，没有则用 `'host'` 作默认并在 README 里标 Stage 5 TODO）
  - 调用 `buildMcpServerSpecs({ resolved, runtimeKind, instanceId: row.id, mcpHttpBaseForHost, mcpHttpBaseForDocker })`
  - 两个 base URL 从 env 读：`MCP_HTTP_BASE_HOST`（默认 `http://localhost:58591`）、`MCP_HTTP_BASE_DOCKER`（默认 `http://host.docker.internal:58591`）
- **同步修改** `packages/backend/src/member-agent/driver-config.ts`（由 Stage 3 W1-3 落盘）
  - 不再基于旧 `resolved.configJson.mcpServers` 手拼（Stage 3 的 W1-3 和 primary 的老实现同构，删 `mcpServers` 手拼段）
  - `buildMemberDriverConfig()` 读 `instance.runtimeKind` 字段（不存在则默认 `'host'`，和 primary 保持一致）
  - 调用 **同一个** `buildMcpServerSpecs({ resolved, runtimeKind, instanceId: instance.id, mcpHttpBaseForHost, mcpHttpBaseForDocker })`
  - env 注入保持 Stage 3 合约不变（`ROLE_INSTANCE_ID` / `CLAUDE_MEMBER` / `IS_LEADER='0'` / `TEAM_HUB_NO_LAUNCH='1'`）
  - 目的：删除 `MTEAM_MCP_ENTRY` / `SEARCHTOOLS_MCP_ENTRY` 后成员 stdio 链路不能断——launch-spec-builder 必须统一处理 primary + member 两类 agent
- 测试：`launch-spec-builder.test.ts`
  - host + builtin → http url localhost
  - docker + builtin → http url host.docker.internal
  - docker + user-stdio → 原样 stdio（Stage 5 再改）
  - headers 正确（`X-Role-Instance-Id` / `X-Is-Leader` / `X-Tool-Visibility`）
  - primary 与 member 复用同一 builder，断言 `instanceId` 透传到 `X-Role-Instance-Id` header
- 测试补充：`member-agent/driver-config.test.ts` 需更新——fixture 走 builder、断言产物里 mteam/searchTools 的 transport 是 http；原有 assemblePrompt 断言保留

**README 要点：** 时序图（`row / instance → resolve → buildMcpServerSpecs → DriverConfig → AgentDriver.start`）、runtimeKind 为 undefined 时的 fallback、headers 规范、primary 和 member 共用 builder 的原因（删除 MTEAM_MCP_ENTRY 后 stdio 链路统一走 HTTP）。

### W2-C · `http/server.ts` 集成 MCP HTTP listener

> 前置：**W0 已合入**（文件已迁到 `packages/backend/src/http/server.ts`）。

**范围：**
- 修改 `packages/backend/src/http/server.ts`（W0 产物，非老 `server.ts`）
  - 在 `comm.start().then(...)` 成功回调里，紧接着 `mcpManager.boot()` 之后调用 `startMcpHttpServer({ hubUrl, commRouter: comm.router })`，结果存到闭包变量
  - `shutdown()` 里先 `await mcpHttpHandle.close()`（放在 `teardownSubscribers()` 之后、`comm.stop()` 之前）
  - 启动失败要记日志，但不阻塞 V2 启动（MCP HTTP 挂了仍允许 host 模式跑 stdio 兜底？不，本 Stage 选择一步到位——MCP HTTP 必须起得来，否则 primary agent 拉不起 builtin MCP；这个点在 README 里标记为"启动硬依赖"）
- 测试：已有 `__tests__/` 里如果有 server 集成测，更新一个断言：启动后 `http://localhost:58591/mcp/mteam` POST 回 405 或符合 Streamable HTTP 的 response（只验 listener 确实起了）

**README 要点：** 启动顺序（`mcpManager.boot → startMcpHttpServer → primaryAgent.boot`）、关停顺序、启动失败的传播。

### Wave 2 汇总

| 模块 | 交付物 | 依赖 |
|---|---|---|
| W2-A | `mcp-manager.ts` 重构 + `mcp-store/types.ts` 增量 + README | W1-A（接口 ResolvedMcpSpec 已锁） |
| W2-B | `launch-spec-builder.ts` + primary & member `driver-config.ts` 同步改造 + README | W2-A + Stage 3 W1-3（member driver-config 落盘） |
| W2-C | `http/server.ts` 集成 + README 附录 | W0 + W1-B（`startMcpHttpServer`） |

> W2-A 和 W2-B 有强前后依赖（产物字段），串行做；W2-C 可与 W2-B 并行（只依赖 W1-B）。

---

## 4. 模块依赖图

```
W0: http/* 拆包（server.ts 423 → 11 个文件，单文件 ≤80 行）
                │ 必须先合入
                ▼
Stage 1: process-runtime/types.ts (前置)
                │
                ▼
   ┌─ W1-A (mcp/server 拆包) ───┐
   ├─ W1-B (mcp-http listener) ─┤
   ├─ W1-C (docker-runtime.ts) ─┤  ◄── 依赖 Stage 1 types
   └─ W1-D (Dockerfile) ────────┘
                │
                ▼ Wave 1 全完
   ┌─ W2-A (mcp-manager.resolve) ──► W2-B (launch-spec-builder + driver-config)
   └─ W2-C (http/server.ts 集成 MCP HTTP listener)   ◄── 依赖 W0
                │
                ▼ Wave 2 全完
          Wave 3: REGRESSION.md 逐条验证
```

---

## 5. 状态表

| ID | 模块 | 状态 | 负责人 | 交付时间 |
|---|---|---|---|---|
| W0 | http/* 拆包（server.ts 423→11文件） | pending | - | - |
| W1-A | mcp/searchtools server 拆包 | pending | - | - |
| W1-B | mcp-http listener + InProcessComm | pending | - | - |
| W1-C | DockerRuntime | pending（等 Stage 1） | - | - |
| W1-D | agent-claude.Dockerfile | pending | - | - |
| W2-A | mcp-manager.resolve 改造 | pending | - | - |
| W2-B | launch-spec-builder + primary&member driver-config 统一改造 | pending | - | - |
| W2-C | server.ts 集成 MCP HTTP | pending | - | - |

Leader 派任务时填负责人；开发者交付时自改 pending → in-review；测试员验完改 in-review → done。
