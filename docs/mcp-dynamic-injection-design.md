# MCP 动态注入机制 — 技术方案

---

## 1. 架构

```
┌─ 角色模板 ──────────────────────────────────────────────────┐
│                                                              │
│  角色配置（persona / task / ...）                              │
│                                                              │
│  ┌─ 角色 MCP 管理工具 ─────────────────────────────────┐    │
│  │                                                     │    │
│  │  - 管理本模板的 MCP 配置（增删改查）                  │    │
│  │  - 订阅 MCP Store 事件维护可用性                     │    │
│  │  - mteam 专属：leader/member 工具分流                │    │
│  │  - 实例化时输出完整 --mcp-config JSON               │    │
│  │  - 提供查询接口供 searchTools MCP 回调              │    │
│  │                                                     │    │
│  └──────┬──────────────┬──────────────────┬────────────┘    │
│         │              │                  │                  │
└─────────┼──────────────┼──────────────────┼──────────────────┘
          │              │                  │
 订阅 bus 事件     实例化时输出         查询接口
          │              │                  │
 ┌────────▼──────┐  ┌───▼──────────┐  ┌───▼──────────────────┐
 │  MCP Store    │  │  角色实例      │  │  searchTools MCP     │
 │  (全局仓库)    │  │  (拿到就能用)  │  │  (独立 MCP server)   │
 └───────────────┘  └──────────────┘  └──────────────────────┘
```

### 角色实例 spawn 后的 MCP 进程

```
CLI 子进程（一个角色实例）
  ├── mteam MCP        — 内置，团队协作工具（平级）
  ├── searchTools MCP  — 内置，动态工具发现（平级，每个实例配置不同）
  ├── mnemo MCP        — 三方
  └── ...其他三方 MCP

每个 MCP server 各自独立进程，各自 ListTools/CallTool。
agent 看到的是扁平工具列表。
```

**mteam 和 searchTools 是平级的两个 MCP server**，不是包含关系。

---

## 2. 各模块职责

| 模块 | 是什么 | 职责 |
|------|--------|------|
| MCP Store | 全局仓库 | MCP server 运行配置（command/args/env）的安装/卸载/查询 |
| 角色 MCP 管理工具 | 角色模板的子模块 | 管模板所有 MCP 配置 + resolve 输出 + 提供查询接口 |
| mteam MCP | 内置 MCP server，跑在 agent 子进程 | 团队协作工具（send_msg/check_inbox 等），按 IS_LEADER env 过滤工具 |
| searchTools MCP | 内置 MCP server，跑在 agent 子进程 | agent 调它 → 它回调 backend 管理工具查询接口 → 返回次屏工具清单 |

### 关键区分

- **mteam** 和 **searchTools** 都是 MCP server，跑在 agent 子进程，对 agent 来说是两个平级的工具集
- **角色 MCP 管理工具**跑在 backend 主进程，是模板的子模块，agent 不直接接触它
- searchTools 的数据来源是管理工具 — 通过 HTTP 回调 backend 查询当前角色的次屏工具清单

---

## 3. 数据结构

模板的 MCP 配置存在 `available_mcps` 字段（JSON），由管理工具读写：

```ts
interface McpToolVisibility {
  name: string;                // MCP 名（对应 store 里的 name）
  surface: string[] | '*';     // 首屏可见工具
  search: string[] | '*';      // searchTools 可搜到的工具
}
```

---

## 4. 核心流程

### 配置变更

```
用户修改模板 MCP 配置（增删 MCP / 调整可见性）
  → 全部通过管理工具的接口
  → 管理工具校验角色隔离（leader 工具不能配到 member 模板）
  → 写入模板的 available_mcps 字段
  → WebSocket 推送前端更新
```

### Store 卸载联动

```
MCP Store 卸载某个 MCP
  → bus emit mcp.uninstalled
  → 管理工具订阅收到 → 更新本模板该 MCP 可用性为不可用
  → WebSocket 推送前端
  → 新实例 resolve 时自动跳过不可用的 MCP
  → 模板配置不删除（store 重新安装后自动恢复）
```

### 实例化

```
创建角色实例
  → 角色模板调管理工具 resolve(ctx)
  → 管理工具输出 --mcp-config JSON，包含：
      mteam:       内置，注入 IS_LEADER env
      searchTools: 内置，注入当前模板的次屏工具配置
      mnemo 等:    从 store 取运行配置，直接透传
  → 角色实例拿到直接 spawn
```

### agent 搜索次屏工具

```
agent 调 searchTools MCP 的 search(query)
  → searchTools 子进程 HTTP 回调 backend
  → backend 管理工具查询：当前角色模板的次屏工具清单，按 query 过滤
  → 返回匹配的工具名 + 描述
  → agent 知道有哪些工具可用
```

---

## 5. 角色隔离

mteam 的工具分为 leader 专属 / member 专属 / 公共三类。管理工具内部维护这个分类。

- leader 模板只能配 leader 专属 + 公共工具
- member 模板只能配 member 专属 + 公共工具
- 配置时校验，越界直接拒绝
- 其他 MCP（mnemo 等）不分角色，所有模板都能配

---

## 6. 模板间隔离

每个模板有自己的管理工具实例，配置互不影响。角色实例的 MCP 配置完全继承自其模板，实例之间天然隔离。

---

## 7. 改动清单

| 类型 | 文件 | 说明 |
|------|------|------|
| 新增 | mcp-store/mcp-manager.ts | 角色 MCP 管理工具（已完成） |
| 新增 | searchtools/ | searchTools MCP server（独立进程，回调 backend 查询） |
| 新增 | mcp/tools/registry.ts | mteam 工具注册表 + 角色分类 |
| 修改 | domain/role-template.ts | availableMcps 类型升级（已完成） |
| 修改 | mcp/config.ts | readEnv 加 isLeader |
| 修改 | mcp/server.ts | ListTools 按角色过滤 |
| 修改 | pty/manager.ts | 拼接逻辑替换为调管理工具 resolve() |
| 不改 | mcp-store/store.ts | 管理工具订阅事件，不加方法 |

---

## 8. 实施计划

| Phase | 内容 |
|-------|------|
| 1 | 管理工具核心 + 模板类型升级 + pty 重构（1A/1B 已完成，1C 进行中） |
| 2 | mteam 工具注册表 + 角色过滤（mcp/server.ts + config.ts） |
| 3 | searchTools 独立 MCP server + backend 查询接口 + resolve 集成 |
