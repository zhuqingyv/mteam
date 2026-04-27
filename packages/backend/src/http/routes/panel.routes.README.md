# Panel Facade Routes

> **面向**：前端开发者

前端统一入口 `/api/panel/*`，薄转发到底层 handler，无业务逻辑。

## 端点映射

| Panel 路径 | 方法 | 转发目标 | 说明 |
|---|---|---|---|
| `/api/panel/teams` | GET | `handleListTeams` (`/api/teams`) | 列所有 team |
| `/api/panel/teams/:id` | GET | `handleGetTeam` (`/api/teams/:id`) | team 详情 |
| `/api/panel/teams/*` | * | `handleTeamsRoute` → `/api/teams/*` | 完整团队 CRUD 透传 |
| `/api/panel/instances` | GET | `handleListInstances` (`/api/role-instances`) | 列所有实例 |
| `/api/panel/instances/*` | * | `handleInstancesRoute` → `/api/role-instances/*` | 完整实例 CRUD 透传 |
| `/api/panel/messages` | POST | `handleMessagesRoute` (`/api/messages/send`) | 前端发消息（裸路径旧契约）|
| `/api/panel/messages/*` | * | `handleMessagesRoute` → `/api/messages/*` | 整树透传：`GET /:id`、`POST /send` 等 |
| `/api/panel/mcp-tools` | GET | `handleMcpToolsRoute` (`/api/mcp-tools/search`) | 工具搜索（裸路径旧契约）|
| `/api/panel/mcp-tools/*` | * | `handleMcpToolsRoute` → `/api/mcp-tools/*` | 整树透传：`GET /search` 等 |
| `/api/panel/mcp/tools` | GET | `handleMcpToolsRoute` (`/api/mcp-tools/search`) | 等同 `/api/panel/mcp-tools`（旧路径保留）|
| `/api/panel/mcp/store` | GET | `handleListMcpStore` (`/api/mcp-store`) | 列 MCP 配置 |
| `/api/panel/roster` | GET | `handleListRoster` (`/api/roster`) | 花名册 |
| `/api/panel/roster/*` | * | `handleRosterRoute` → `/api/roster/*` | 完整花名册 CRUD 透传 |
| `/api/panel/templates` | GET | `handleListTemplates` (`/api/role-templates`) | 列模板 |
| `/api/panel/templates/*` | * | `handleTemplatesRoute` → `/api/role-templates/*` | 完整模板 CRUD 透传 |
| `/api/panel/primary-agent` | GET | `handleGetPrimaryAgent` (`/api/primary-agent`) | 总控当前配置（未配置返回 `null`）|
| `/api/panel/primary-agent/*` | * | `handlePrimaryAgentRoute` → `/api/primary-agent/*` | 完整生命周期透传：POST `/config` / `/start` / `/stop` |
| `/api/panel/cli` | GET | `handleListCli` (`/api/cli`) | CLI 快照（不触发扫描）|
| `/api/panel/cli/*` | * | `handleCliRoute` → `/api/cli/*` | 完整 CLI 透传：POST `/refresh` 立即重扫 |

> ⚠️ Turn 快照 / 历史不走 HTTP。`/api/panel/driver/*` 已废弃，前端改调 WS op `get_turns` / `get_turn_history`（见 `ws/handle-turns.ts`）。

## 8 条门面映射速查（对齐前端 INDEX.md 白名单）

```
/api/panel/teams          → /api/teams              (整树，handleTeamsRoute)
/api/panel/instances      → /api/role-instances     (整树，handleInstancesRoute)
/api/panel/messages       → /api/messages/*         (整树，handleMessagesRoute；裸路径映射 /send)
/api/panel/mcp-tools      → /api/mcp-tools/*        (整树，handleMcpToolsRoute；裸路径映射 /search)
/api/panel/roster         → /api/roster             (整树，handleRosterRoute)
/api/panel/templates      → /api/role-templates     (整树，handleTemplatesRoute)
/api/panel/primary-agent  → /api/primary-agent      (整树，handlePrimaryAgentRoute)
/api/panel/cli            → /api/cli                (整树，handleCliRoute)
```

## 设计原则

1. 纯转发，零业务逻辑
2. 底层 handler 不改动
3. 主 Agent 相关查询（Turn 快照/历史）走 WS op，不占用 HTTP 门面
4. teams / instances / roster / templates / primary-agent / cli 做完整子路径透传（支持 CRUD，不只 GET list）
5. 底层 `/api/teams` 等路径前端**禁调**，详见 [docs/frontend-api/INDEX.md](../../../../../docs/frontend-api/INDEX.md) §5 黑名单
