# 服务端 HTTP API 端点清单（前端对接用）

> 任务 #11 产出。读取 `packages/backend/src/api/panel/` 与 `packages/backend/src/http/routes/` 得到。
> 仅罗列端点、方法、body / query 形状、关键错误码；**不含前端如何消费**（见 `PRODUCT-REQUIREMENTS.md`）。
> 路由注册入口：`packages/backend/src/http/router.ts`。

## 1. 角色模板 Role Templates

| 方法 | 路径 | 说明 | 关键字段 | 错误码 |
|---|---|---|---|---|
| GET | `/api/role-templates` | 列出全部模板 | — | — |
| GET | `/api/role-templates/:name` | 取单个模板 | — | 404 |
| POST | `/api/role-templates` | 新建 | `name` (1~64)、`role` (1~32)、`description`、`persona` (≤8192)、`availableMcps[{name,surface,search}]` | 400/409 |
| PATCH | `/api/role-templates/:name` | 部分更新 | 同上，可选子集 | 400/404 |
| DELETE | `/api/role-templates/:name` | 删除 | — | 404；被实例引用返 409 |

事件：`template.created / updated / deleted`。

## 2. 角色实例 Role Instances

| 方法 | 路径 | 说明 | 关键字段 | 错误码 |
|---|---|---|---|---|
| GET | `/api/role-instances` | 列出实例 | — | — |
| POST | `/api/role-instances` | 创建实例 | `templateName`、`memberName`、`isLeader?`、`task? (≤2048)`、`leaderName?` | 400/404 |
| POST | `/api/role-instances/:id/activate` | 面板/测试激活（PENDING→ACTIVE） | — | 404/409 |
| POST | `/api/role-instances/:id/request-offline` | Leader 批准下线（ACTIVE→PENDING_OFFLINE） | `callerInstanceId`（或 header `X-Role-Instance-Id`） | 400/403/404/409 |
| DELETE | `/api/role-instances/:id?force=1` | 删除实例；ACTIVE 需先 request-offline，或 `?force=1` | — | 404/409 |
| GET | `/api/role-instances/:id/inbox?peek=true&limit=50` | 实例收件箱（messages.routes） | `peek`、`limit` ≤200 | 404 |

事件：`instance.created / activated / offline_requested / deleted / session_registered`。

## 3. 团队 Teams

| 方法 | 路径 | 说明 | 关键字段 | 错误码 |
|---|---|---|---|---|
| GET | `/api/teams` | 列出团队 | — | — |
| GET | `/api/teams/:id` | 团队详情（含 members） | — | 404 |
| POST | `/api/teams` | 创建团队 | `name` (1~64)、`leaderInstanceId`、`description?` | 400/409 |
| POST | `/api/teams/:id/disband` | 解散团队 | — | 404/409 |
| GET | `/api/teams/:id/members` | 列出成员 | — | 404 |
| POST | `/api/teams/:id/members` | 添加成员 | `instanceId`、`roleInTeam?` | 400/404/409 |
| DELETE | `/api/teams/:id/members/:instanceId` | 移除成员 | — | 404 |
| GET | `/api/teams/:teamId/messages?limit=50&before=` | 团队消息历史 | `limit ≤200`、`before` cursor | — |

事件：`team.created / disbanded / member_joined / member_left`。

## 4. Sessions

| 方法 | 路径 | 说明 | 关键字段 |
|---|---|---|---|
| POST | `/api/sessions/register` | 成员 agent 注册 session（PENDING→ACTIVE） | `instanceId`、`claudeSessionId?` |

> 通常由成员 agent 调用，前端一般不直接触达。

事件：`instance.activated`、`instance.session_registered`。

## 5. Primary Agent（总控）

| 方法 | 路径 | 说明 | 关键字段 | 错误码 |
|---|---|---|---|---|
| GET | `/api/primary-agent` | 取配置（未配置返 `200 + null`） | — | — |
| POST | `/api/primary-agent/config` | 配置（首次生成 id，之后 upsert） | `name` (1~64)、`cliType`、`systemPrompt`、`mcpConfig[{serverName,mode:'all'\|'whitelist',tools?}]` | 400 |
| POST | `/api/primary-agent/start` | 启动 | — | 409（已在跑） |
| POST | `/api/primary-agent/stop` | 停止 | — | 409（未在跑） |

事件：`primary_agent.configured / started / stopped`。

## 6. CLI 扫描

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cli` | 读内存快照 |
| POST | `/api/cli/refresh` | 立即重新扫描并返回快照 |

事件：`cli.available / unavailable`。

## 7. Roster（通讯录）

| 方法 | 路径 | 说明 | 关键 query/body |
|---|---|---|---|
| GET | `/api/roster?scope=team\|local\|remote&callerInstanceId=` | 列出；`scope=team` 必须带 caller | — |
| GET | `/api/roster/search?q=&scope=&callerInstanceId=` | 按 q 模糊搜 | — |
| GET | `/api/roster/:instanceId` | 取单条 | 404 |
| POST | `/api/roster` | 添加 | `instanceId`、`memberName`、`scope`、`status`、`address`、`alias?`、`teamId?`、`task?` |
| PATCH | `/api/roster/:instanceId` | 更新（status/address/teamId/task） | — |
| PATCH | `/api/roster/:instanceId/alias` | 设置备注名 | `alias` |
| DELETE | `/api/roster/:instanceId` | 删除 | 404 |

## 8. MCP Store（第三方 MCP 管理）

| 方法 | 路径 | 说明 | 关键字段 |
|---|---|---|---|
| GET | `/api/mcp-store` | 列出全部 MCP（含 builtin） | — |
| POST | `/api/mcp-store/install` | 安装 | `name` (1~64)、`command`、`args?`、`env?`、`transport? ('stdio'\|'sse')`、`displayName?`、`description?` |
| DELETE | `/api/mcp-store/:name` | 卸载（builtin 不可卸） | — |

事件：`mcp.installed / uninstalled`。

## 9. MCP 工具搜索（agent 调用路径）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mcp-tools/search?instanceId=&q=` | 按实例的 availableMcps 搜"次屏工具"（search 允许但 surface 不展示） |

## 10. 消息 Messages（W2-I）⭐ 对接聊天入口

| 方法 | 路径 | 说明 | 关键字段 |
|---|---|---|---|
| POST | `/api/messages/send` | 前端/用户发消息（body 里 `from` 会被强注入为 `user`，忽略客户端值） | `to.address`、`to.kind='agent'`、`content`、`kind? ('chat'\|'task'\|'broadcast')`、`summary?`、`replyTo?`、`attachments?` |
| GET | `/api/messages/:id?markRead=true` | 按 id 取消息；`markRead=true` 同时标已读 | — |
| GET | `/api/role-instances/:id/inbox?peek=true&limit=50` | 实例收件箱 | — |
| GET | `/api/teams/:teamId/messages?limit=50&before=` | 团队消息历史 | — |

关键：`/api/messages/send` 返回 `{ messageId, route }`；`route` 来自 `CommRouter.dispatch`。服务端强注入 `from.kind='user'` + `fromAddress='user:local'`。
Content-Type 必须 `application/json`，否则 `415`。

## 11. Driver Turn 快照（T-10）⭐ 对接聊天历史

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/panel/driver/:driverId/turns?limit=10` | `{ active: Turn\|null, recent: Turn[] }`；limit 默认 10 上限 50 |

语义（设计文档 §4.8 S1）：
- driver 从未跑过 / 无 active → `active=null`，不 404；
- `recent` 为已关闭 Turn，按 endTs 降序。

---

## 附录 · 路由派发顺序（router.ts）

```
roster → mcp-tools(+mcp-store 透传) → cli → primary-agent →
messages → teams → sessions → instances → templates → driver-turns
```

不命中则返回 `404 not found`（统一 `http-utils.notFound`）。

## 附录 · 常用错误响应体

```json
{ "error": "..." }
```

统一壳：`ApiResponse = { status, body }`；`body` 在失败时是 `{ error }`，成功时是业务数据或 `null`。
