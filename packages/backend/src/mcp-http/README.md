# `mcp-http/` — 内置 MCP 的 HTTP listener

把 `mteam` / `searchTools` 两个内置 MCP 从 stdio 子进程模式搬到同进程 HTTP Streamable 模式。agent 侧无论 host 还是 docker runtime，统一通过 HTTP 访问这两条 MCP；不再为每个 agent session fork 子进程。

设计文档：`docs/phase-sandbox-acp/stage-4-mcp-http.md`、`stage-4/TASK-LIST.md` §1.3 / §W1-B。

## 入口

```ts
import { startMcpHttpServer } from './mcp-http/index.js';

const handle = await startMcpHttpServer({
  port: 58591,                       // 可选，默认读 MCP_HTTP_PORT，再默认 58591
  host: '127.0.0.1',                 // 可选，默认 '127.0.0.1'；不要绑 0.0.0.0
  hubUrl: 'http://localhost:58590',  // searchTools 回源 backend 的 base
  commRouter: commServer.router,     // InProcessComm 直接 dispatch 消息
});

// handle.url === 'http://127.0.0.1:58591'
await handle.close();
```

- **host 必须 127.0.0.1**：listener 明文传递 `X-Role-Instance-Id`，任何对外暴露就是越权通道。容器里 agent 通过 `host.docker.internal:58591` 跨进宿主机 loopback。
- **port 传 0** 时走随机端口，仅测试用；生产固定 58591 便于 launch-spec-builder 和防火墙规则。

## 路由

| 路径 | MCP 名 | 会话策略 | 可见性 |
|---|---|---|---|
| `POST /mcp/mteam` | mteam | stateful（`sessionIdGenerator: randomUUID`） | 由 `X-Is-Leader` header 决定 |
| `POST /mcp/searchTools` | searchTools | stateful | 无 leader 限制 |
| 其他 | — | — | 返回 404 JSON |

## 请求头契约

| Header | 来源 | mteam | searchTools |
|---|---|---|---|
| `X-Role-Instance-Id` | launch-spec-builder → agent 进程 env | 必填 | 必填 |
| `X-Is-Leader` | `'1'` / `'0'` | 必填 | — |
| `X-Tool-Visibility` | `JSON.stringify({ surface, search })`；`{}` → `*` | 预留 | — |
| `Mcp-Session-Id` | 初次 init 后由 SDK 透传 | 由 SDK 管理 | 由 SDK 管理 |

缺 `X-Role-Instance-Id` 返回 `400 Missing X-Role-Instance-Id header`。

> `X-Tool-Visibility` 当前仅在 header 契约里保留，mteam `visibleTools()` 暂只看 `isLeader`；等 Stage 5 策略层用时再接。

## Session 生命周期

- 每次 `initialize` 请求 → listener new 一个 `Server` + `StreamableHTTPServerTransport` + `InProcessComm`，用 transport 生成的 sessionId 存入 map。
- 后续同 session 的 request 走 `Mcp-Session-Id` header → map 命中 → 复用 transport。
- transport `onclose` → 从 map 删掉，并 `comm.close()`（InProcessComm 无实际资源，幂等）。
- `handle.close()` → 清空两个 map、`server.close()`；启动后不中断在途请求，由 Node HTTP `close()` 自然终结。

## `InProcessComm`（`in-process-comm.ts`）

`CommLike` 的同进程实现，等价语义替换 stdio 版的 `CommClient`：

| 维度 | `CommClient`（stdio） | `InProcessComm`（HTTP listener） |
|---|---|---|
| 传输 | unix socket → `CommServer.onConnection` | 直调 `commRouter.dispatch` |
| 注册 | `register` + ack | 无（同进程不需要） |
| ack 语义 | 等 server 回 `ack` | `dispatch` resolve 即视为投递成功 |
| 失败路径 | socket 断线/ack 超时抛错 | `route: 'dropped'` / `'remote-unsupported'` → 抛错 |
| 关闭 | 断 socket | no-op |

**等价性边界**：

- stdio `CommClient` 会经过 `CommServer` 的 `handleLine` → `router.dispatch`；`InProcessComm` 直接跳到 `router.dispatch`。中间 `CommServer` 的 offline replay / connection register 逻辑在 HTTP 路径**不参与**（因为 HTTP 会话本身不是 registry 的一员）。
- 因此 HTTP agent 发出的消息能到达其他 online 成员 / 系统 handler / driver dispatcher；但 HTTP agent **不是** `comm.registry` 的一条 online 连接 —— 它不会成为其他人 `send_msg` 的目标。目标路由依然靠 `driverDispatcher`（Stage 3 注入）或 registry 里已有的 socket（stdio 残留）或 offline store。

## 文件边界

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.ts` | ~80 | `startMcpHttpServer()` / 关停 / 路径 dispatch |
| `mteam-handler.ts` | ~70 | `/mcp/mteam` 请求 → MteamEnv + InProcessComm + Server + transport |
| `searchtools-handler.ts` | ~60 | `/mcp/searchTools` 请求 → SearchEnv + Server + transport |
| `in-process-comm.ts` | ~50 | `CommLike` 实现 |
| `handler-utils.ts` | ~45 | body 解析 / 错误响应 / session map |

全部 ≤ 150 行硬线。

## 测试

`index.test.ts`：真 HTTP listener + 真 `CommRouter` + 真 MCP `Client`（`StreamableHTTPClientTransport`）。覆盖：

1. leader / non-leader 的 ListTools 差异。
2. `send_msg` 走 InProcessComm → `router.dispatch` → 注入的 `driverDispatcher` 能观察到 id + text。
3. 缺 `X-Role-Instance-Id` 返回 400。
4. searchTools 的 `search` 回调到临时 hub http server。
5. InProcessComm 直接 send 到 `local:system` 能被 `systemHandler` 观察。

不 mock bus / commRouter / db。

## 依赖 & 被依赖

- 依赖 `mcp/server.ts#createMteamServer`、`searchtools/server.ts#createSearchToolsServer`（W1-A 交付）。
- 被 W2-C `http/server.ts` 调用启动。
- 被 W2-B `launch-spec-builder` 作为 mteam/searchTools 的 MCP transport 指向（`http://localhost:58591` 或 `http://host.docker.internal:58591`）。
