# `searchtools/` — searchTools MCP Server

跟 `mteam` 平级的内置 MCP，只注册一个 `search` 工具。agent 调 `search(query)` → backend `GET /api/mcp-tools/search?instanceId=...&q=...` → 返回当前角色模板的次屏工具清单（模板配了但不在 surface 里的工具）。

不做动态注册、不发 `list_changed`。返回的是元数据（`mcpServer` / `toolName` / `description`），agent 自己再去目标 MCP 调工具。

## 两个入口

| 入口 | 适用场景 | 调用方 |
|---|---|---|
| `createSearchToolsServer(env)` | 由调用方自己挂 transport | Stage 4 W1-B 的 `mcp-http/` listener、单测 |
| `runSearchToolsServerStdio()` | 子进程被 CLI 拉起，走 stdio | `searchtools/index.ts` |

### `createSearchToolsServer(env): Server`

- 纯构造器：只 `new Server(...)` + `setRequestHandler`
- `env: SearchEnv` —— `{ instanceId, hubUrl }`，决定 HTTP 回调的目标

### `runSearchToolsServerStdio(): Promise<void>`

- 读环境变量 → 构造 Server → 挂 `StdioServerTransport` → 绑信号清理
- 仅供 `index.ts` 调用

## `SearchEnv` 来源

| 字段 | stdio 路径（`readSearchEnv`） | HTTP 路径（W1-B） |
|---|---|---|
| `instanceId` | `ROLE_INSTANCE_ID` env（必填） | `X-Role-Instance-Id` header |
| `hubUrl` | `V2_SERVER_URL` / `TEAM_HUB_URL` / `http://localhost:${V2_PORT||58580}` | 由 listener 注入（透传 `McpHttpOptions.hubUrl`） |

## 行为

- `query` 为空 → `{ error: "query is required" }`，`isError: true`
- HTTP 非 2xx → `{ error: "search failed (HTTP <code>): <body>" }`
- fetch 抛错 → `{ error: "network error: <msg>" }`
- 未知工具名 → `{ error: "unknown tool: <name>" }`

## 测试

`server.test.ts` 用临时 `http.createServer` 承接 hub 请求，用 `InMemoryTransport.createLinkedPair()` 连一个 MCP Client 跑 ListTools / CallTool。不 mock fetch、不 mock 数据。

## 注意事项

- Server 实例不共享 —— 每个 session / transport 单独 new 一个。
- `search` 工具无 leader 限制，所有成员可见。
- 与 `mteam` 不同，搜工具不需要 `CommLike`（纯 HTTP 回源）。
