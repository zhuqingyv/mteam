# http/ — HTTP server 拆包

本目录是 backend HTTP 层的入口。原 `src/server.ts`（423 行）拆成这里的 11 个文件，每文件 ≤ 80 行，便于后续 Stage 在某一路由下加逻辑时不炸主文件。

## 目录

```
http/
├── server.ts              createServer + startServer + shutdown
├── http-utils.ts          readBody / CORS_HEADERS / jsonResponse / notFound
├── router.ts              主 route()，按顺序把请求派发到各 routes/*.ts
├── panel-html.ts          servePanelHtml：两路径候选，读 src/panel.html 或 build 同目录
├── reconcile.ts           reconcileStaleInstances：启动时清理 zombie role_instances
└── routes/
    ├── roster.routes.ts          /api/roster + /api/roster/search + /:id + /:id/alias
    ├── teams.routes.ts           /api/teams + /:id + /:id/disband + /:id/members[/:m] + /by-instance/:id
    ├── instances.routes.ts       /api/role-instances + /:id + /:id/activate + /:id/request-offline
    ├── templates.routes.ts       /api/role-templates + /:name
    ├── primary-agent.routes.ts   /api/primary-agent + /config + /start + /stop
    ├── cli.routes.ts             /api/cli + /api/cli/refresh
    ├── sessions.routes.ts        /api/sessions/register
    └── mcp-tools.routes.ts       /api/mcp-tools/search + /api/mcp-store[...] 透传
```

## 路由约定

每个 `routes/*.ts` 导出单一入口函数：

```ts
handleXxxRoute(req, pathname, method, query?): Promise<ApiResponse | null>
```

返回值语义：
- `ApiResponse`（含 `status`/`body`）— 我处理了，结束。
- `null` — 这个前缀不归我管，交给 router 继续尝试下一个。

常量（路径前缀）下沉到各自的 route 文件里，**不**集中在 `router.ts`。新加前缀时不需要改 router 之外的地方。

## 如何新增一条路由

### 加到现有 route 文件里
直接在对应 `handleXxxRoute` 里加 `if (pathname === ...)` 分支。

### 开一个新 route 文件
1. 在 `routes/` 下新建 `xxx.routes.ts`，导出 `handleXxxRoute(req, pathname, method, query?)`。
2. 在 `router.ts` 的 `handlers` 数组里按优先级插入一行 `() => handleXxxRoute(req, pathname, method, query)`。
3. 顺序很重要：**更具体的前缀放前面**（如 `/api/roster/search` 必须在 `/api/roster` 之前判定，这在 roster.routes.ts 内部已处理；若你的新路由和现有 handler 路径冲突，需放到冲突 handler 之前）。

## Stage 4 W2-C 接入点

`startServer()` 里 `comm.start().then(...)` 的回调，在 `mcpManager.boot()` 之后、`primaryAgent.boot()` 之前插入 `startMcpHttpServer({ hubUrl, commRouter: comm.router })` 的调用；`shutdown()` 里在 `teardownSubscribers()` 之后、`comm.stop()` 之前 `await mcpHttpHandle.close()`。

## Stage 5 sandbox/policy 开关接入点

同样在 `startServer()` 启动序列里追加即可；若新加的 boot/teardown 之间有顺序依赖，按"启动倒序关停"的通用原则摆。

## 测试

集成测（`__tests__/http-*.test.ts`）直接 `import { createServer } from '../http/server.js'`，走 `http.Server.listen(0)` 随机端口 + `fetch` 全链路，不 mock DB/bus。路由层本身不单独单测（纯派发，handler 单测已在 `api/panel/*` 层覆盖）。
