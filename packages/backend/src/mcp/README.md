# `mcp/` — mteam MCP Server

mteam MCP server 的模块代码。对外暴露 8 个 agent-to-agent 协作工具（send_msg / check_inbox / lookup / activate / deactivate / request_offline / add_member / list_members）。

## 两个入口

| 入口 | 适用场景 | 调用方 |
|---|---|---|
| `createMteamServer(env, comm)` | 由调用方自己挂 transport（stdio / HTTP / 内存对） | Stage 4 W1-B 的 `mcp-http/` listener、单测 |
| `runMteamServerStdio()` | 子进程被 CLI 拉起，走 stdio + 真实 `CommClient` | `mcp/index.ts`（bin: `mcp-team-hub-mteam`） |

### `createMteamServer(env, comm): Server`

- 纯构造器：只 `new Server(...)` + `setRequestHandler`，**不** `server.connect()`、**不** 绑 SIGINT/SIGTERM/stdin.close
- 调用方负责 transport 与清理
- `env: MteamEnv` —— 从 `readEnv()` 或 HTTP header 构造；决定 `isLeader` → 工具可见性
- `comm: CommLike` —— 见下节；`send_msg` 走这里出站

### `runMteamServerStdio(): Promise<void>`

- 读环境变量 → 构造 `CommClient` → `connectCommWithRetry`（3 次重试）→ 构造 Server → 挂 `StdioServerTransport` → 绑信号清理
- 仅供 `index.ts` 调用

## `CommLike`（`comm-like.ts`）

```ts
export interface CommLike {
  ensureReady(): Promise<void>;
  send(opts: { to: string; payload: Record<string, unknown> }): Promise<void>;
  close(): void;
}
```

工具层（`tools/registry.ts` 的 `ToolDeps.comm`、`tools/send_msg.ts`）依赖 `CommLike`，不依赖具体传输。当前两种实现：

| 实现 | 位置 | 传输 |
|---|---|---|
| `CommClient` | `comm-client.ts` | unix socket → CommServer |
| `InProcessComm` | `mcp-http/in-process-comm.ts`（W1-B 交付） | 内进程直调 `commRouter.route()` |

## `visibleTools(isLeader)` 语义

`tools/registry.ts` 把工具按 `leaderOnly` 标记。非 leader 调用 `list_tools` 时，`request_offline` / `add_member` 被过滤掉；若 non-leader 硬发 `call_tool` 调这类工具，返回 `{ error: "tool 'xxx' is leader-only" }` 的 `isError` 文本。

## 测试

- `server.test.ts`：用 `InMemoryTransport.createLinkedPair()` 连一个 MCP Client，覆盖 ListTools / CallTool 的契约行为；`CommLike` 用 stub（仅记录 `send` 调用）。
- 不触达数据库 / 真实 socket / 真实 bus。业务语义测试走更上层的 integration suite。

## 注意事项

- `createMteamServer` 返回的 Server 实例不能共享给多个 transport —— 每个 session 单独 new 一个。
- `isLeader` 在 stdio 路径从 `IS_LEADER` env 读；在 HTTP 路径由 listener 从 `X-Is-Leader` header 构造 `MteamEnv`。
- `commSock` 在 HTTP 路径不需要（`InProcessComm` 不读它）；stdio 路径必填。
