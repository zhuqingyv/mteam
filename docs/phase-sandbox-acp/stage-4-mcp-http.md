# Stage 4 — 内置 MCP HTTP 化 + DockerRuntime

> 状态：设计稿 · 2026-04-25
> 前置：Stage 1（`ProcessRuntime` 抽象）、Stage 2（`AgentDriver` 解耦）
> 后续：Stage 5（安全策略 + 测试收尾）

> **[修订注 · 2026-04-25]** §4.3 的 `wrapChild` 示意代码与冻结签名不一致，以 [`INTERFACE-CONTRACTS.md`](./INTERFACE-CONTRACTS.md) §1 为准：
> - **删除 `stderr: child.stderr!`** — `RuntimeHandle` 没有 `stderr` 字段。需要 stderr 透传请在 `LaunchSpec.stdio.stderr` 配 `'inherit'` 让 docker CLI 继承父进程 stderr（默认就是 `'inherit'`）。
> - `onExit` 回调签名是 `(code: number | null, signal: string | null) => void`（两个独立参数），**不是** `cb({ code, signal })`（对象参数）。
> - `kill` 的 2s 宽限由 runtime 层负责实现（契约要求 SIGTERM → 2s → SIGKILL 幂等），不能把宽限责任推给 driver 层。
> - §4.4 提到的 "driver 层已有 `kill('SIGKILL')` 兜底" 在 Stage 2 改造后**已移除**（driver 不再杀进程，见 stage-2 §4.3）；DockerRuntime 的 kill 必须自含完整宽限升级逻辑。
> - 实现代码请 `import type { RuntimeHandle, LaunchSpec, ProcessRuntime } from '<process-runtime>/types.js'`，不要就地再声明一份。

## 1. 目标

1. **内置 MCP 原生 HTTP 化**：把 `packages/backend/src/mcp/`（mteam）和 `packages/backend/src/searchtools/`（searchTools）两个内置 MCP server 从单一 `StdioServerTransport` 改造成"同时暴露 stdio + MCP Streamable HTTP"，由 backend 进程常驻一个 HTTP endpoint。
2. **DockerRuntime 落地**：在 Stage 1 定义的 `ProcessRuntime` 抽象之下新增 `DockerRuntime` 实现，用 `docker run -i --rm ...` 在容器里拉起 ACP agent 子进程；stdin/stdout 直通 docker CLI 的管道。
3. **打通容器↔host 的 MCP 通道**：主 Agent 进程从 host 迁入容器后，通过 `host.docker.internal:PORT/mcp/mteam` 访问内置 MCP；外部 MCP（npx/uvx 类 stdio 子进程）通过 volume 挂载 host 的 npm/uvx cache，保持 stdio 不变（Stage 5 再收尾）。

本阶段**不**交付：用户级网络隔离、iptables 规则、密钥隔离（全部挪到 Stage 5）。

---

## 2. 为什么不用 MCP Bridge

早期方案曾讨论在 host 侧写一个 stdio→SSE 网关（"MCP Bridge"）：容器里用 SSE/HTTP，host 侧把请求转回已有的 stdio 子进程。这条路被否掉，理由：

1. **MCP spec 2025-03 已定义 Streamable HTTP**，SDK（`@modelcontextprotocol/sdk@1.29.0`）原生提供 `StreamableHTTPServerTransport`（`node_modules/.bun/@modelcontextprotocol+sdk@1.29.0/.../server/streamableHttp.d.ts`）。自研一层 stdio↔SSE 适配属于重新造轮子。
2. **AgentDriver 已支持 http/sse transport**。`packages/backend/src/agent-driver/driver.ts:158` 的 `toAcpMcpServers()` 对 `transport: 'http' | 'sse'` 分支原生传递给 ACP SDK。当前只有 `packages/backend/src/primary-agent/driver-config.ts:54` 硬编码 `transport: 'stdio'`，这就是唯一分流点。
3. **少一跳**：Bridge 方案是 `agent → bridge(stdio 适配) → mteam stdio`，直接 HTTP 方案是 `agent → mteam http`，省一个进程 + 一次 serde。
4. **工作量**：Bridge 估算 ~600 行，直接 HTTP 化估算 ~300 行（详见 mnemo 决策 #351）。

结论：**内置 MCP 自己原生提供 HTTP，外部 MCP 走 volume 挂载 + stdio 不变**。

---

## 3. 内置 MCP HTTP 化方案

### 3.1 现状

`packages/backend/src/mcp-store/mcp-manager.ts:121-140` 的 `resolve()` 对 `__builtin__` 入口产出 stdio 规格：

```ts
// mcp-manager.ts:121
if (cfg.command === '__builtin__') {
  mcpServers[entry.name] = {
    command: process.execPath,
    args: [MTEAM_MCP_ENTRY],
    env: {
      ROLE_INSTANCE_ID: ctx.instanceId,
      V2_SERVER_URL: ctx.hubUrl,
      TEAM_HUB_COMM_SOCK: ctx.commSock,
      IS_LEADER: ctx.isLeader ? '1' : '0',
      MTEAM_TOOL_VISIBILITY: JSON.stringify(vis),
    },
  };
}
```

`mcp-manager.ts:144-151` 又无条件追加 `searchTools` 的 stdio 规格。产物最终由 `driver-config.ts:50-58` 转成 `McpServerSpec`，清一色 `transport: 'stdio'`。

在沙箱里这条路走不通：
- `process.execPath` 是 host 的 node，容器里没这个路径。
- `MTEAM_MCP_ENTRY` 指向 `backend/src/mcp/index.js` 的 host 绝对路径。
- `TEAM_HUB_COMM_SOCK` 是 host 侧的 unix socket，容器无法访问。
- mteam server 里 `CommClient` 需要 bus 回调 backend，必须在 host 进程里才有意义。

### 3.2 改造思路：同进程双 transport

mteam/searchTools 本来就是 backend 代码的一部分，只是被 spawn 成了子进程才变得"独立"。HTTP 化的关键一步是把它们的"listener"挪到 backend 主进程里长驻：

```
backend 主进程
  ├── V2 HTTP Server (已有, :58580)
  ├── Comm Unix Socket Server (已有)
  └── [新] MCP HTTP Server (:58590)  ← 同进程挂载 mteam + searchTools
       ├── POST /mcp/mteam          → StreamableHTTPServerTransport
       └── POST /mcp/searchTools    → StreamableHTTPServerTransport
```

- **stdio 入口保留**：`mcp/index.ts` 和 `searchtools/index.ts` 不动，`pnpm mteam:dev` 或旧的 stdio 子进程调用还能用（过渡期兼容）。
- **新增 HTTP 入口**：`backend/src/mcp-http/` 目录承载 HTTP wrapper；server 构造逻辑从 `mcp/server.ts`、`searchtools/server.ts` 里抽出，供两处复用。

### 3.3 改造后的 server 结构

`packages/backend/src/mcp/server.ts:39-83` 目前把 `new Server(...)`、handler 注册、`StdioServerTransport.connect()` 全耦合在 `runMteamServer()` 一个函数里。重构为：

```ts
// mcp/server.ts（改造后）
export function createMteamServer(env: MteamEnv, comm: CommClient): Server {
  const server = new Server({ name: 'mteam', version: '0.1.0' },
    { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, /* ... */);
  server.setRequestHandler(CallToolRequestSchema, /* ... */);
  return server;
}

export async function runMteamServerStdio(): Promise<void> {
  // 原 runMteamServer() 改名，只管 stdio transport
  const env = readEnv();
  const comm = new CommClient(env.commSock, `local:${env.instanceId}`);
  await connectCommWithRetry(comm, `local:${env.instanceId}`);
  const server = createMteamServer(env, comm);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

searchTools 做对称处理（`searchtools/server.ts` 同样抽 `createSearchToolsServer`）。

### 3.4 HTTP listener 挂载

`packages/backend/src/mcp-http/index.ts`（新文件）暴露：

```ts
export interface McpHttpOptions {
  port: number;                // 默认 58590，可 env 覆盖
  hubUrl: string;              // 内部复用
  commSock: string;            // mteam 需要，HTTP 版仍走 host 本地 unix socket
}

export async function startMcpHttpServer(opts: McpHttpOptions): Promise<{
  url: string;
  close: () => Promise<void>;
}>;
```

内部按实例维度建 transport：每次 `POST /mcp/mteam` 携带 `X-Role-Instance-Id`、`X-Is-Leader`、`X-Tool-Visibility` 头，listener 拿到头后构造 `MteamEnv`、`CommClient`，再 `new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })`，绑定到新建的 `Server` 实例。

关键点：
- **stateless 还是 stateful**：建议 `sessionIdGenerator: () => randomUUID()`（stateful），让 MCP SDK 自动管理 session 生命周期；agent 进程重连一次即可（ACP 生命周期本身短，不存在长时间空转）。
- **并发隔离**：不同 `ROLE_INSTANCE_ID` 走不同 `Server` 实例（或复用 Server + 在 handler 里按 session 查 env），各自持有独立 `CommClient`。
- **关闭**：backend 进程退出时 `await close()`，内部遍历 active transport 全部 close。

### 3.5 driver-config 分流

`packages/backend/src/primary-agent/driver-config.ts:50-58` 当前：

```ts
const mcpServers: McpServerSpec[] = Object.entries(
  resolved.configJson.mcpServers,
).map(([name, spec]) => ({
  name,
  transport: 'stdio',
  command: spec.command,
  args: spec.args,
  env: spec.env,
}));
```

改造后（伪码）：

```ts
const mcpServers: McpServerSpec[] = Object.entries(
  resolved.configJson.mcpServers,
).map(([name, spec]) => {
  if (sandboxMode && isBuiltin(name)) {
    return {
      name,
      transport: 'http',
      url: `${mcpHttpUrlForContainer}/mcp/${name}`,
      headers: {
        'X-Role-Instance-Id': row.id,
        'X-Is-Leader': '1',
        'X-Tool-Visibility': JSON.stringify(spec.env.MTEAM_TOOL_VISIBILITY ?? {}),
      },
    };
  }
  return { name, transport: 'stdio', command: spec.command, args: spec.args, env: spec.env };
});
```

其中：
- `sandboxMode`：取决于 Stage 1 的 `runtimeKind === 'docker'`。
- `isBuiltin(name)`：判断 `name === 'mteam'` 或 `name === 'searchTools'`（或检查 `mcp-manager.resolve()` 产物来源，最好把 builtin 标记透传出来，见 §6）。
- `mcpHttpUrlForContainer`：在容器里固定为 `http://host.docker.internal:58590`；在 host 模式下退化为 `http://localhost:58590`（方便调试一致化，但 host 模式下内置 MCP 默认还是 stdio 路径不变）。

### 3.6 mteam 的 `CommClient` 怎么办

stdio 版的 `CommClient` 通过 `TEAM_HUB_COMM_SOCK` 拨 host 侧 unix socket。HTTP 版在 backend 主进程里，**天然已经跟 bus 在同一进程**——可以直接替换成"内存事件订阅"版实现：

```ts
export interface CommLike {
  ensureReady(): Promise<void>;
  send(envelope: Envelope): Promise<SendResult>;
  recv(opts: RecvOptions): Promise<Envelope[]>;
  // ...
}
```

HTTP 路径走 `InProcessComm`（直接调 `commBus.publish()`），stdio 路径继续走 `CommClient`。Stage 4 只引入接口抽象；`InProcessComm` 的具体实现属于小工作量、跟 HTTP wrapper 一起落地。

---

## 4. DockerRuntime 实现

前置：Stage 1 已交付 `ProcessRuntime`、`RuntimeHandle`、`LaunchSpec` 抽象（由 `process-runtime` 模块提供）。本节只描述 `DockerRuntime` 这个具体实现。

### 4.1 Dockerfile 设计

镜像分层：

```
docker/agent-claude.Dockerfile
──────────────────────────────
FROM node:20-slim

# 1. 系统依赖（最小）
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 2. 预装 Claude ACP 包（版本 pin 在 package.json 里）
RUN npm install -g @anthropic-ai/claude-acp@<pinned>

# 3. 容器入口：读 stdin、用 claude-acp 启动，stdout 直连 ACP JSON-RPC
ENTRYPOINT ["claude-acp"]
CMD []
```

说明：
- 镜像名：`mteam/agent-claude:<tag>`，tag 对应 backend 发布号。
- codex adapter 对应 `docker/agent-codex.Dockerfile`，同构但 CMD 不同；Stage 4 先做 claude，codex 跟进。
- 不装额外语言运行时；外部 MCP 的 npx/uvx 依赖走 volume 挂载（Stage 5 细化）。
- 不 `COPY` backend 代码，镜像里只有 ACP agent 本体；mteam/searchTools 不打进镜像（它们在 host backend 进程里，通过 HTTP 暴露）。

### 4.2 spawn 逻辑

```ts
// process-runtime/runtimes/docker.ts（新文件）
import { spawn, type ChildProcess } from 'node:child_process';
import type { ProcessRuntime, LaunchSpec, RuntimeHandle } from '../types.js';

export interface DockerRuntimeConfig {
  image: string;                       // e.g. 'mteam/agent-claude:0.4.0'
  network: string;                     // e.g. 'mteam-bridge'
  extraDockerArgs?: string[];
}

export function createDockerRuntime(cfg: DockerRuntimeConfig): ProcessRuntime {
  return {
    kind: 'docker',
    async spawn(spec: LaunchSpec): Promise<RuntimeHandle> {
      const args = [
        'run', '-i', '--rm',
        '--network', cfg.network,
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        ...envArgs(spec.env),
        ...(cfg.extraDockerArgs ?? []),
        cfg.image,
      ];
      const child = spawn('docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return wrapChild(child);
    },
  };
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}
```

关键点：
- **stdin/stdout 直通**：`docker run -i` 把容器 stdin 接到 docker CLI 的 stdin，容器 stdout 回到 docker CLI 的 stdout；ACP SDK 的 JSON-RPC 管道透明穿过。
- **`--rm`**：容器退出即删；不残留。
- **`--network mteam-bridge`**：详见 §5。
- **`--cap-drop ALL`、`--security-opt no-new-privileges`**：最小权限，默认开启（最小可用）。更细的 seccomp/apparmor 挪到 Stage 5。
- **`env` 注入**：把 `DriverConfig.env` 整体通过 `-e KEY=VALUE` 传入。`ANTHROPIC_API_KEY` 等密钥也走这条，Stage 5 再讨论密钥隔离。

### 4.3 `RuntimeHandle` 封装

```ts
// process-runtime/runtimes/docker.ts（续）
function wrapChild(child: ChildProcess): RuntimeHandle {
  return {
    pid: child.pid ?? -1,
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    kill: async (signal = 'SIGTERM') => {
      // docker CLI 拿到信号后会把 SIGTERM 转发给容器 PID 1
      if (!child.killed) child.kill(signal);
    },
    onExit: (cb) => {
      child.once('exit', (code, signal) => cb({ code, signal }));
    },
  };
}
```

`LaunchSpec` / `RuntimeHandle` 的字段定义由 Stage 1 决定；此处假设与 `driver.ts:80-97` 当前对 `ChildProcess` 的使用保持兼容（`stdin`、`stdout`、`stderr`、`once('exit', ...)`、`kill()`）。

### 4.4 `kill` 语义

- `kill('SIGTERM')`：调 `child.kill('SIGTERM')` → docker CLI 进程收到信号 → docker 转发到容器 PID 1（`claude-acp`）。
- 5s 内未退出 → driver 层已有 `kill('SIGKILL')` 兜底（参见 `driver.ts:134`）。
- `--rm` 保证容器在 exit 后被 docker engine 清理；不做额外 `docker rm`。
- 异常强杀场景：调用方可追加 `docker kill <container-id>`，但 Stage 4 内不主动做——只依赖 docker CLI 子进程死亡 → `--rm` 收尾。

### 4.5 `onExit` 语义

直接桥接 docker CLI 子进程的 `exit` 事件：
- code=0：容器正常退出（agent session close）。
- code≠0：docker CLI 报错（镜像不存在、网络不存在、容器内崩溃均会 surface 这里）。
- signal：父进程收到 SIGTERM 被传下去。

driver 层 `driver.ts:87-94` 的 `child.once('exit', ...)` 已经处理这三种。

---

## 5. 网络策略

### 5.1 bridge 网络

由 backend 启动时保证 `mteam-bridge` 存在：

```bash
docker network inspect mteam-bridge \
  || docker network create --driver bridge mteam-bridge
```

容器通过 `--network mteam-bridge` 加入；默认 docker bridge 网络提供 `host.docker.internal` DNS 解析到 host 网卡。

### 5.2 host MCP 端口暴露

backend 的 MCP HTTP listener（§3.4）绑定 `127.0.0.1:58590`——**不**绑 `0.0.0.0`，外部不可达。容器通过 `host.docker.internal` 从 bridge 网络内部访问：

- macOS / Windows Docker Desktop：`host.docker.internal` 天然可用。
- Linux：容器需加 `--add-host=host.docker.internal:host-gateway`，这行要加到 §4.2 的 `docker run` 参数里（Linux only，Stage 5 做探测）。

### 5.3 出站限制（Stage 5 细化）

Stage 4 默认策略：
- 容器能到 host.docker.internal:58590（MCP HTTP）。
- 容器能到外网（docker 默认 NAT），因为 claude-acp 要打 Anthropic API。
- 容器**不能**发起到 host 任意端口的连接——理论上 bridge 网络可以，这是 Stage 5 要用 iptables 或独立 network policy 锁紧的点。

本阶段不交付 iptables 规则，只明确意图：**访问 host.docker.internal 的 MCP 端口、可以访问 Anthropic API、其他出站在 Stage 5 再决定**。

---

## 6. `mcp-manager.resolve()` 改造

当前 `mcp-manager.resolve()`（`mcp-manager.ts:101-154`）把"怎么启动"这种运行时细节焊死在产物里——直接吐 `{ command, args, env }` 这种 stdio spec。沙箱化之后同一个 MCP 配置要能分别渲染成 stdio / HTTP / docker stdio 多种形态，所以要把产物抽象一层。

### 6.1 新产物：`ResolvedMcpSpec`

```ts
// mcp-store/types.ts（增量）
export type ResolvedMcpSpec =
  | {
      kind: 'builtin';            // mteam / searchTools
      name: 'mteam' | 'searchTools';
      env: Record<string, string>;
      visibility: McpToolVisibility;
    }
  | {
      kind: 'user-stdio';         // store 里装的外部 MCP
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

`mcp-manager.resolve()` 去掉 `configJson`（以及 `process.execPath` / `MTEAM_MCP_ENTRY` 等运行时字符串），改吐 `ResolvedMcpSpec[]`。它只回答"**有哪些 MCP、各自是什么来源、可见性如何、环境变量要注入什么**"。

### 6.2 新责任位：`launch-spec-builder`

`packages/backend/src/primary-agent/launch-spec-builder.ts`（新文件）把 `ResolvedMcpSpec[]` + runtime 信息 → `McpServerSpec[]`：

| ResolvedMcpSpec.kind | runtime=host                | runtime=docker                          |
|----------------------|-----------------------------|-----------------------------------------|
| `builtin`            | `http://localhost:58590/mcp/<name>` + headers | `http://host.docker.internal:58590/mcp/<name>` + headers |
| `user-stdio`         | 原样 stdio（`command/args/env`） | 挂载 volume 后 stdio（Stage 5 补）         |

`buildDriverConfig()`（`driver-config.ts:38`）调用 `launch-spec-builder`，得到 `McpServerSpec[]` 塞进 `DriverConfig`。

> 说明：host 模式下内置 MCP 也走 HTTP 是一个**刻意的简化**——不再维护双路径，上线时再回归验证。如果过渡期要保留 host=stdio 路径，`launch-spec-builder` 分支加一行开关即可，成本很低。本文档推荐一步到位全 HTTP。

---

## 7. 改动文件清单

### 7.1 新增

| 文件 | 作用 |
|---|---|
| `packages/backend/src/mcp-http/index.ts` | HTTP listener 启动/关闭 |
| `packages/backend/src/mcp-http/mteam-handler.ts` | `/mcp/mteam` 的 transport 工厂 |
| `packages/backend/src/mcp-http/searchtools-handler.ts` | `/mcp/searchTools` 的 transport 工厂 |
| `packages/backend/src/mcp-http/in-process-comm.ts` | mteam HTTP 版的 `CommLike` 实现 |
| `packages/backend/src/primary-agent/launch-spec-builder.ts` | `ResolvedMcpSpec[]` → `McpServerSpec[]` 分流 |
| `packages/backend/src/process-runtime/runtimes/docker.ts` | DockerRuntime 实现（依赖 Stage 1 抽象） |
| `docker/agent-claude.Dockerfile` | claude ACP agent 镜像 |
| `docker/agent-codex.Dockerfile`（可选，跟进） | codex ACP agent 镜像 |

### 7.2 修改

| 文件 | 改动 |
|---|---|
| `packages/backend/src/mcp/server.ts` | 拆 `createMteamServer` + `runMteamServerStdio`；接受 `CommLike` 而非硬绑 `CommClient` |
| `packages/backend/src/mcp/index.ts` | 调用 `runMteamServerStdio`（仅函数改名） |
| `packages/backend/src/searchtools/server.ts` | 对称拆 `createSearchToolsServer` + `runSearchToolsServerStdio` |
| `packages/backend/src/searchtools/index.ts` | 同上 |
| `packages/backend/src/mcp-store/mcp-manager.ts` | `resolve()` 返回 `ResolvedMcpSpec[]`；去掉 `process.execPath` / `MTEAM_MCP_ENTRY` / `SEARCHTOOLS_MCP_ENTRY` 常量 |
| `packages/backend/src/mcp-store/types.ts` | 新增 `ResolvedMcpSpec` 类型 |
| `packages/backend/src/primary-agent/driver-config.ts` | 调用 `launch-spec-builder`；不再直接拼 `McpServerSpec[]` |
| `packages/backend/src/index.ts`（backend 入口） | 启动时调用 `startMcpHttpServer`；退出时 close |

### 7.3 测试新增

- `packages/backend/src/process-runtime/runtimes/docker.test.ts`
- `packages/backend/src/mcp-http/index.test.ts`
- `packages/backend/e2e/sandbox-acp.e2e.ts`（端到端，可能放 Stage 5）

---

## 8. 测试策略

### 8.1 DockerRuntime 契约测

`docker.test.ts` 针对 `spawn → stdin/stdout → kill → onExit` 的全周期：

1. **spawn 成功**：用一个轻量测试镜像 `node:20-slim`，`CMD ["node", "-e", "process.stdin.pipe(process.stdout)"]`；spawn 后写 `hello\n`，断言 stdout 读到 `hello\n`。
2. **kill SIGTERM 干净退出**：spawn 后调 `handle.kill('SIGTERM')`，`onExit` 回调在 2s 内触发，`code` 或 `signal` 非空。
3. **kill SIGKILL 兜底**：容器无视 SIGTERM 时（用 `trap` 屏蔽），走 driver 层现有 SIGKILL 逻辑，仍能收尾。
4. **镜像缺失报错**：image 名故意拼错，spawn 的 promise reject 或 `onExit` 非零 code。

> 约束：跑这些测试要求宿主装了 docker daemon；CI 上用 dockerd service 打开即可。用户明确要求**不 mock**，所以不 stub docker CLI。

### 8.2 内置 MCP HTTP 集成测

`mcp-http/index.test.ts` 用 ACP SDK 的 client side（`acp.ClientSideConnection` + `new McpServer({ type: 'http', url })`）跑：

1. **listToolsFiltered**：leader 场景，`ListTools` 返回的工具全集与 `visibleTools(true)` 一致；非 leader 返回裁剪后的 set。
2. **callTool: send_msg**：打通 `InProcessComm` → 真 bus，断言 `bus.on('comm.send')` 收到事件；**不 mock bus**。
3. **session 隔离**：两个不同 `X-Role-Instance-Id` 并发调用，互不串扰。
4. **searchTools search**：打通到 `http://localhost:<backendPort>/api/mcp-tools/search`（这是真 V2 API），返回至少一个命中。

### 8.3 端到端

`sandbox-acp.e2e.ts`（可能归 Stage 5，这里只列目标）：

1. backend 启动（host 模式）。
2. 创建 primary agent row，`runtimeKind='docker'`。
3. driver 启动 → 容器起 → agent 就绪。
4. 发 prompt "用 mteam 的 send_msg 给自己发一条消息"。
5. 断言：
   - bus 收到 `driver.tool_call` 事件（name=`send_msg`）。
   - bus 收到 `comm.send` 事件（from = 该 instanceId）。
   - driver 收到 `tool_result`（ok=true）。
   - driver.stop → 容器 3s 内被 `--rm` 清理（`docker ps -a` 查不到）。

---

## 9. 架构图

### 9.1 Host 模式（host=docker container 被替换为 host 进程；保留对照）

```
┌──────────────────────────────── host ─────────────────────────────────┐
│                                                                       │
│  backend process (node)                                               │
│  ├─ V2 HTTP :58580 ─────────── /api/*                                 │
│  ├─ Comm Unix Socket ───────── /tmp/.../comm.sock                     │
│  └─ MCP HTTP :58590  ───────── /mcp/mteam, /mcp/searchTools           │
│           ▲                                                           │
│           │ loopback                                                  │
│  claude-acp (child process, spawned by AgentDriver)                   │
│     stdio JSON-RPC ⇄ backend via ACP SDK                              │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### 9.2 Sandbox 模式（Stage 4 目标）

```
┌──────────────────────────────── host ─────────────────────────────────┐
│                                                                       │
│  backend process (node)                                               │
│  ├─ V2 HTTP   :58580 ──── /api/*                                      │
│  ├─ Comm Sock ──────────── /tmp/.../comm.sock                         │
│  └─ MCP HTTP  :58590 ──── /mcp/mteam, /mcp/searchTools                │
│         ▲   (127.0.0.1 only)                                          │
│         │                                                             │
│         │ host.docker.internal:58590                                  │
│         │                                                             │
│  ┌──────┴────────── docker network "mteam-bridge" ───────────────┐    │
│  │                                                               │    │
│  │   ┌─── container: mteam/agent-claude ─────────────────┐       │    │
│  │   │                                                   │       │    │
│  │   │   claude-acp (PID 1)                              │       │    │
│  │   │     │ ACP JSON-RPC over stdio                     │       │    │
│  │   │     │     ↑            ↑                          │       │    │
│  │   │     │     │            │ MCP tool calls           │       │    │
│  │   │     │     │            └─→ http://host.docker.internal:58590
│  │   │     │                                             │       │    │
│  │   │   stdin  stdout                                   │       │    │
│  │   │     ▲     ▼                                       │       │    │
│  │   └─────│─────│───────────────────────────────────────┘       │    │
│  │         │     │                                               │    │
│  │      docker run -i --rm  (managed by DockerRuntime)           │    │
│  │         ▲     ▼                                               │    │
│  └─────────│─────│───────────────────────────────────────────────┘    │
│            │     │                                                    │
│  AgentDriver.child (ChildProcess over `docker` CLI)                   │
│     ndJsonStream ⇄ ACP ClientSideConnection                           │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘

                        通信路径（端到端一次工具调用）
                        ──────────────────────────────
  [agent 容器] claude-acp
      │ 1. MCP tool call (JSON-RPC)    transport: http
      ▼
  [host bridge net] host.docker.internal:58590
      │ 2. HTTP POST /mcp/mteam        (MCP Streamable HTTP)
      ▼
  [backend] MCP HTTP listener
      │ 3. StreamableHTTPServerTransport → Server.handler
      ▼
  [backend] mteam Server.handler(callTool)
      │ 4. 直接调用 bus.publish('comm.send', ...)  (同进程)
      ▼
  [backend] event bus → 其他成员 / V2 API
```

### 9.3 生命周期图

```
  DriverConfig                                    LaunchSpec
  (runtimeKind='docker',      +—————————————+    (cmd=ignored, env=...)
   mcpServers with http url)  │buildDriver  │────→   ProcessRuntime.spawn()
              ─────────────→  │Config +     │              │
                              │launchSpec   │              ▼
                              │Builder      │     docker run -i --rm ...
                              +—————————————+              │
                                                           ▼
                                                  ChildProcess (docker CLI)
                                                     │
                                                     │ stdin/stdout
                                                     ▼
                               AgentDriver.bringUp() ──→ ACP initialize / newSession
                                                             │
                                                             ▼
                                                     READY (status)
                                                             │
                                                             ▼ prompt()
                                                     container 内 agent 工作
                                                             │
                                                             ▼ tool_call
                                                     MCP HTTP → backend → bus
                                                             │
                                                             ▼ stop()
                                                     kill('SIGTERM')
                                                             │
                                                             ▼ exit
                                                     docker --rm 清容器
                                                             │
                                                             ▼
                                                     STOPPED (status)
```

---

## 10. 风险 & 后续

- **`CommClient` → `InProcessComm` 语义必须一致**：stdio 版 unix socket 有一个实际网络跳，HTTP 版是同进程函数调用。要谨慎对齐 `ensureReady`、`recv` 的 timeout 行为（单测覆盖）。
- **Stage 5 依赖的 hook**：iptables / seccomp / apparmor 都会修改 §4.2 的 `docker run` 参数列表，`DockerRuntimeConfig.extraDockerArgs` 已经预留出口。
- **`host.docker.internal` 在 Linux 需要显式 add-host**：Stage 5 要做 OS 探测，而不是硬编码。
- **stateful session 与 agent 重启**：MCP SDK stateful 模式下 session 绑 UUID，容器重启意味着新的 agent → 新 session；`agent-driver` 的重启逻辑会自然产生新的 ACP session，MCP session 不跨重启共享——符合预期。
- **过渡期兼容**：stdio 入口（`mcp/index.ts`、`searchtools/index.ts`）保留；如果有 pnpm script / 调试脚本依赖它们，改造后继续可用。

---

附录：关键文件行号速查

- stdio builtin 产物：`packages/backend/src/mcp-store/mcp-manager.ts:121-140`、`:144-151`
- stdio 硬编码：`packages/backend/src/primary-agent/driver-config.ts:50-58`
- `toAcpMcpServers()` 已支持 http/sse：`packages/backend/src/agent-driver/driver.ts:158-183`
- `McpServerSpec` 类型：`packages/backend/src/agent-driver/types.ts:8-16`
- mteam server 构造：`packages/backend/src/mcp/server.ts:39-83`
- searchTools server 构造：`packages/backend/src/searchtools/server.ts:87-118`
- MCP SDK Streamable HTTP：`@modelcontextprotocol/sdk@1.29.0/dist/esm/server/streamableHttp.*`
