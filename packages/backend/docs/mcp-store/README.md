# MCP Store — MCP 配置管理

## 1. 概述

MCP Store 管理所有可用的 MCP server 配置。每个 MCP 一个 JSON 文件。
spawn agent 时按模板 available_mcps 读文件，动态拼 --mcp-config。

## 2. 存储

目录：`~/.claude/team-hub/mcp-store/`
每个 MCP 一个 JSON 文件：

```json
// ~/.claude/team-hub/mcp-store/mteam.json
{
  "name": "mteam",
  "displayName": "Team Hub",
  "description": "内置团队协作工具",
  "command": "__builtin__",
  "args": [],
  "env": {},
  "transport": "stdio",
  "builtin": true
}
```

```json
// ~/.claude/team-hub/mcp-store/mnemo.json
{
  "name": "mnemo",
  "displayName": "Mnemo Memory",
  "description": "团队知识库",
  "command": "uvx",
  "args": ["mnemo-mcp"],
  "env": {},
  "transport": "stdio",
  "builtin": false
}
```

装了几个 = 目录下几个 .json 文件。

## 3. 接口（3 个，极简）

### GET /api/mcp-store — 列出所有已安装 MCP
- 读目录，解析每个 JSON，返回数组
- Response 200: `[{ name, displayName, description, command, args, env, transport, builtin }, ...]`

### POST /api/mcp-store/install — 安装 MCP
- Body: `{ name, displayName?, description?, command, args?, env?, transport? }`
- 写文件到 `mcp-store/{name}.json`
- `builtin` 字段不允许用户设为 true
- Response 201: 写入的完整配置
- 409: name 已存在

### DELETE /api/mcp-store/:name — 卸载 MCP
- 删文件 `mcp-store/{name}.json`
- `builtin=true` 的不可删 → 403
- Response 204
- 404: 不存在

## 4. 默认数据

V2 server 首次启动时，如果 `mcp-store/` 目录不存在或 `mteam.json` 不存在，自动创建：
- `mkdir mcp-store/`
- 写 `mteam.json`（`builtin=true`, `command="__builtin__"`）

## 5. spawn 时拼接

```
读模板 available_mcps → ["mteam", "mnemo"]
遍历：
  读 mcp-store/{name}.json
  文件不存在 → stderr warn，跳过
  command === "__builtin__" → 走内置 proxy 分支
  否则 → { command, args, env } 写入 mcpConfig.mcpServers[name]
写临时文件 → --mcp-config 传给 CLI
```

## 6. 模板 available_mcps 与 Store 的关系

模板的 `available_mcps` 只是"希望用"的列表，Store 里有的才"真的用"。spawn 时取交集：

```
模板 available_mcps = ["mteam", "mnemo", "github"]

spawn 时遍历：
  mteam.json  → 存在 → 注入 ✅
  mnemo.json  → 不存在（已卸载）→ 跳过，stderr warn
  github.json → 存在 → 注入 ✅

实际注入：mteam + github
```

- 模板里多写了已卸载的 MCP **不报错**，只是不生效
- 卸载 MCP 时**不需要自动清理模板**的 available_mcps
- 前端编辑模板时，可选 MCP 列表从 `GET /api/mcp-store` 实时拉，已卸载的自然不在列表里
- 已跑的 agent 不受卸载影响（MCP 子进程已在内存），只影响新 spawn 的

## 7. 文件结构

```
v2/mcp-store/
├── store.ts        # 读目录/读文件/写文件/删文件
└── types.ts        # McpConfig 类型
```

## 8. 不做
- 不做前端 UI
- 不做异步安装 job
- 不做 DB 表
- 不做版本管理
- 不做 registry 自动发现
