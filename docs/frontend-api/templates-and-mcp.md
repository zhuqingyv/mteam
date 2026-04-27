# Templates & MCP & CLI API

> **面向**：前端 UI（模板管理页 / MCP 商店页 / CLI 扫描页的 HTTP 调用方）。特殊说明：
> - **`GET /api/mcp-tools/search`** — 由 agent 通过内置 MCP 工具 `searchTools` 发起，前端一般不直接调（面板"工具搜索"功能若存在也会走这里）。
> - **CLI 扫描接口** — 前端面板用于展示 CLI 可用状态；后端自身后台 30s 轮询是内部机制，与前端无关。

全部返回 JSON。成功 2xx，错误 4xx/5xx + `{ error: string }`。写操作会 emit bus 事件（`template.*` / `mcp.*`），前端通过 WS 订阅推送。

## TS 类型

```ts
interface McpToolVisibility {
  name: string;                 // MCP server 名，例如 "mteam"
  surface: string[] | '*';      // 首屏展示的工具名，'*' = 全部
  search: string[] | '*';       // searchTools 可搜到的工具名，'*' = 全部
}

interface RoleTemplate {
  name: string;                 // 主键，1~64 字符
  role: string;                 // 1~32 字符
  description: string | null;   // ≤1024
  persona: string | null;       // ≤8192
  availableMcps: McpToolVisibility[];
  createdAt: string;            // ISO
  updatedAt: string;
}

interface McpConfig {
  name: string;
  displayName: string;
  description: string;
  command: string;              // "__builtin__" 表示内置
  args: string[];
  env: Record<string, string>;
  transport: 'stdio' | 'sse';
  builtin: boolean;             // true 不可卸载
}

interface CliInfo {
  name: string;                 // 白名单: "claude" | "codex"
  available: boolean;
  path: string | null;          // available=false 时为 null
  version: string | null;
}

interface SearchHit {
  mcpServer: string;
  toolName: string;
  description: string;
}
```

## 角色模板 `/api/role-templates`

### `GET /api/role-templates`
列出全部模板（按 createdAt 升序）。

响应 `200`: `RoleTemplate[]`

### `POST /api/role-templates`
创建模板。`name` 重复 → `409`。

请求体:
```json
{
  "name": "reviewer",
  "role": "qa",
  "description": "code reviewer",
  "persona": "You review PRs...",
  "availableMcps": [
    { "name": "mteam", "surface": ["send_msg"], "search": "*" }
  ]
}
```

响应 `201`: `RoleTemplate`

### `GET /api/role-templates/:name`
响应 `200`: `RoleTemplate`；`404` 不存在。`name` 需 `encodeURIComponent`。

### `PUT /api/role-templates/:name`
增量更新。请求体字段可选（`role` / `description` / `persona` / `availableMcps`），`name` 不可改。

响应 `200`: `RoleTemplate`；`404` 不存在。

### `DELETE /api/role-templates/:name`
响应 `204`；`404` 不存在；`409` 仍被活跃实例引用（需先删实例）。

## MCP 商店 `/api/mcp-store`

### `GET /api/mcp-store`
列出全部 MCP（含内置 mteam）。

响应 `200`: `McpConfig[]`

### `POST /api/mcp-store/install`
安装用户 MCP。`builtin=true` 会被拒绝（400）。`name` 重复 → `409`。

请求体:
```json
{
  "name": "mnemo",
  "displayName": "Mnemo",
  "description": "team knowledge base",
  "command": "npx",
  "args": ["-y", "@mnemo/mcp"],
  "env": { "MNEMO_KEY": "..." },
  "transport": "stdio"
}
```

响应 `201`: `McpConfig`

### `DELETE /api/mcp-store/:name`
响应 `204`；`404` 不存在；`403` 内置 MCP 不可卸载。

## MCP 工具搜索 `/api/mcp-tools/search`

> **调用方**：agent（内置 MCP `searchTools` 工具触发，按 `instanceId` 过滤可见工具）+ 前端 UI（如有"工具搜索"面板）。

### `GET /api/mcp-tools/search?instanceId=<id>&q=<query>`
根据实例所用模板的 `availableMcps`，返回"在 search 白名单内、但不在 surface 首屏"的工具，按 `q` 对 name/description 做大小写不敏感子串匹配。

`leaderOnly` 的工具对非 leader 实例硬过滤。

响应 `200`:
```json
{ "hits": [ { "mcpServer": "mteam", "toolName": "team_create", "description": "..." } ] }
```

错误: `400` 缺 `instanceId` / `q`；`404` 实例或模板不存在。

## CLI 扫描器 `/api/cli`

内存快照，后台 30s 轮询。状态翻转会 emit `cli.available` / `cli.unavailable`。

### `GET /api/cli`
读当前快照，不触发扫描。

响应 `200`: `CliInfo[]`，顺序固定 `["claude", "codex"]`。

### `POST /api/cli/refresh`
立即重新扫描 + diff（可能发事件），返回最新快照。

响应 `200`: `CliInfo[]`

## 触发的 bus 事件

写操作会 emit 以下事件，前端 WS 可订阅：

- `template.created` / `template.updated` / `template.deleted` — payload 含 `templateName`
- `mcp.installed` / `mcp.uninstalled` — payload 含 `mcpName`
- `cli.available` / `cli.unavailable` — payload 含 `cliName`（available 时还带 `path` / `version`）

订阅 scope: 以上都走 `global`。
