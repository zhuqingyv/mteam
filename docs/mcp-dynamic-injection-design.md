# MCP 动态注入机制 — 技术方案

---

## 1. 架构

```
┌─ 角色模板 ──────────────────────────────────┐
│                                              │
│  角色配置（persona / task / ...）              │
│                                              │
│  ┌─ 角色 MCP 管理工具 ───────────────────┐   │
│  │                                       │   │
│  │  - 管理本模板的 MCP 配置（增删改查）    │   │
│  │  - 订阅 MCP Store 事件维护可用性       │   │
│  │  - mteam 专属：leader/member 工具分流  │   │
│  │  - 实例化时输出完整 --mcp-config JSON  │   │
│  │                                       │   │
│  └──────────┬───────────────┬────────────┘   │
│             │               │                │
└─────────────┼───────────────┼────────────────┘
              │               │
     订阅 bus 事件        实例化时输出
              │               │
     ┌────────▼──────┐   ┌───▼──────────┐
     │  MCP Store    │   │  角色实例      │
     │  (全局仓库)    │   │  (拿到就能用)  │
     └───────────────┘   └──────────────┘
```

---

## 2. 职责

**角色 MCP 管理工具**是角色模板的子模块，负责模板里所有 MCP 相关的事：

| 职责 | 说明 |
|------|------|
| 配置管理 | 模板的 MCP 增删改查全走它，模板本身不碰 MCP 细节 |
| 可见性配置 | 每个工具的 surface（首屏）/ search（searchTools 可搜）配置 |
| 角色隔离 | leader 工具不能配到 member 模板，反之同理 |
| mteam 分流 | 仅针对 mteam MCP 做 leader/member 工具差异处理，这是专属业务逻辑 |
| Store 联动 | 订阅 mcp.installed / mcp.uninstalled，实时更新本模板 MCP 可用性 |
| 实例化输出 | resolve() → 完整 --mcp-config JSON，调用方直接用 |

**不做的事**：不管 MCP Store 的 CRUD，不管角色实例的生命周期。

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

向后兼容：旧格式 `["mteam"]` 自动解析为 `[{ name: "mteam", surface: '*', search: [] }]`。

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
  → WebSocket 推送前端（模板编辑界面标红）
  → 新实例 resolve 时自动跳过不可用的 MCP
  → 模板配置不删除（store 重新安装后自动恢复）
```

### 实例化

```
创建角色实例
  → 角色模板调管理工具 resolve(ctx)
  → 管理工具：
      1. 读本模板的 MCP 配置
      2. 过滤掉不可用的（store 里不存在的）
      3. mteam 专属：根据 isLeader 注入 IS_LEADER env + 工具可见性 env
      4. 其他 MCP：直接取 store 里的运行配置
      5. 输出完整 --mcp-config JSON
  → 角色实例拿到直接 spawn，不关心任何 MCP 细节
```

---

## 5. 角色隔离

mteam 的工具分为 leader 专属 / member 专属 / 公共三类。管理工具内部维护这个分类。

- leader 模板只能配 leader 专属 + 公共工具
- member 模板只能配 member 专属 + 公共工具
- 配置时校验，越界直接拒绝
- 其他 MCP（mnemo 等）不分角色，所有模板都能配

---

## 6. searchTools

mteam MCP server 内部实现：

- 首屏：ListTools 返回 surface 配置的工具
- 次屏：agent 调 searchTools(query) → 命中工具动态注册 → sendToolListChanged() → Claude 重拉
- server capabilities 声明 `tools: { listChanged: true }`

---

## 7. 模板间隔离

每个模板有自己的管理工具实例，配置互不影响。模板 A 配了 mnemo，模板 B 没配，互不干扰。角色实例的 MCP 配置完全继承自其模板，实例之间天然隔离。

---

## 8. 改动清单

| 类型 | 文件 | 说明 |
|------|------|------|
| 新增 | mcp-store/mcp-manager.ts | 角色 MCP 管理工具 |
| 新增 | mcp/tools/registry.ts | mteam 工具注册表 + 角色分类 |
| 新增 | mcp/tools/search_tools.ts | searchTools 元工具 |
| 修改 | domain/role-template.ts | availableMcps 类型升级 + 管理工具集成 |
| 修改 | mcp/config.ts | readEnv 加 isLeader + toolVisibility |
| 修改 | mcp/server.ts | ListTools/CallTool 用注册表 + 可见性 |
| 修改 | pty/manager.ts | 拼接逻辑替换为调管理工具 resolve() |
| 不改 | mcp-store/store.ts | 管理工具订阅事件，不加方法 |

---

## 9. 实施计划

| Phase | 内容 |
|-------|------|
| 1 | 管理工具核心（订阅 store + resolve 输出 + 模板类型升级 + pty 重构） |
| 2 | mteam 工具注册表 + 角色隔离 + leader/member 分流 |
| 3 | searchTools + listChanged 动态注册 |
