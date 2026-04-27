# 主 Agent 设计

---

## 定位

mteam 应用的门面 Agent。全局单例，独立于 role_instances 体系之外。生命周期跟随应用启停。通过 comm socket 可与所有角色实例通信。

---

## 数据

单独一张表 `primary_agent`，全局只有一行：

```sql
CREATE TABLE IF NOT EXISTS primary_agent (
  id            TEXT PRIMARY KEY,        -- 永久唯一标识，首次创建时生成，之后永远不变（切换 CLI / 重启 / 重配都不影响）
  name          TEXT NOT NULL,           -- 显示名
  cli_type      TEXT NOT NULL,           -- 'claude' | 'codex'（从 CLI 管理器可用列表选）
  system_prompt TEXT NOT NULL DEFAULT '',
  mcp_config    TEXT NOT NULL DEFAULT '[]', -- JSON，McpToolVisibility[]
  status        TEXT NOT NULL DEFAULT 'STOPPED'
                CHECK(status IN ('STOPPED','RUNNING')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

---

## 模块

```
packages/backend/src/primary-agent/
├── types.ts       — PrimaryAgentRow / PrimaryAgentConfig
├── primary-agent.ts — PrimaryAgent 类（单例）
```

---

## PrimaryAgent 类

```ts
class PrimaryAgent {
  boot(): void          // 应用启动时：读表 → 有配置则自动 spawn + comm 注册
  teardown(): void      // 应用关闭时：kill 进程 + 断 comm

  configure(config): void  // 设置 CLI 类型 + MCP 列表 + 名字 + 系统提示词
  getConfig(): PrimaryAgentRow | null

  start(): void         // spawn CLI 进程 + comm 注册
  stop(): void          // kill 进程 + comm 断开

  isRunning(): boolean
}
```

---

## 通信

- comm 地址 = `local:<primary_agent.id>`，永久不变（首次生成后写表，之后只读）
- 其他角色实例通过这个地址给主 Agent 发消息
- 主 Agent 也可以给任何角色实例发消息
- 未来 mlink 跨机通信时，外部 mteam 找过来的默认对接方就是主 Agent

---

## 接口

```
GET  /api/primary-agent           — 查当前配置和状态
POST /api/primary-agent/config    — 设置 CLI 类型 + MCP 列表 + 名字 + 系统提示词
POST /api/primary-agent/start     — 启动
POST /api/primary-agent/stop      — 停止
```

---

## 事件

通过 bus 可被订阅：

```
primary_agent.started   — 主 Agent 启动
primary_agent.stopped   — 主 Agent 停止
primary_agent.configured — 配置变更
```

---

## 生命周期

```
应用启动
  → server.startServer()
  → primaryAgent.boot()
  → 读 primary_agent 表
  → 有配置 + CLI 可用 → 自动 start()（spawn CLI + comm 注册）
  → 无配置 → 等用户通过 API 配置

应用运行中
  → 用户 POST /config 设置配置
  → 用户 POST /start 启动
  → 主 Agent spawn CLI → comm 注册 → 就绪
  → 可收发消息

应用关闭
  → primaryAgent.teardown()
  → kill CLI 进程 + comm 断开
```

---

## 与其他模块的关系

| 模块 | 关系 |
|------|------|
| CLI 管理器 | start 前校验 cli_type 是否可用 |
| MCP 管理工具 | resolve MCP 配置（跟角色模板一样的流程） |
| comm | 注册固定地址，收发消息 |
| pty | spawn CLI 进程 |
| bus | emit 事件，前端 WebSocket 收到 |
| role_instances | 无关，主 Agent 不在这张表里 |

---

## 改动清单

| 类型 | 文件 |
|------|------|
| 新增 | db/schemas/primary_agent.sql |
| 新增 | primary-agent/types.ts |
| 新增 | primary-agent/primary-agent.ts |
| 新增 | api/panel/primary-agent.ts |
| 修改 | bus/types.ts（3 个新事件） |
| 修改 | server.ts（boot/teardown/路由） |
