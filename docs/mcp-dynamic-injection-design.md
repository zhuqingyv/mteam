# MCP 动态注入机制 — 技术方案

> 三层分离：MCP Store / 角色模板 / MCP 管理器

---

## 1. 现状问题

| # | 问题 |
|---|------|
| 1 | `availableMcps: string[]` 只记名字，没有工具可见性 |
| 2 | MCP 配置拼接散落在 `pty/manager.ts`，与 spawn 强耦合 |
| 3 | spawn 时才查 store，不订阅变更，无前置感知 |
| 4 | mteam MCP 的 ListTools 静态返回全部工具，不区分角色 |
| 5 | 没有 searchTools 元工具，工具增长后首屏膨胀 |

---

## 2. 三层架构

```
┌─────────────┐     ┌──────────────┐     ┌───────────────────┐
│  MCP Store   │     │  角色模板      │     │  MCP 管理器         │
│ (全局仓库)    │     │ (模板配置)     │     │ (快照 + resolve)   │
│              │     │              │     │                   │
│ command      │     │ mcpConfig[]  ├────►│ resolve(template) │
│ args/env     │     │ surface/search│    │ → 完整注入 JSON    │
│ transport    │     │              │     │                   │
│ builtin      │     │ 不关心运行配置  │     │ 内存快照(Map)      │
└──────┬───────┘     └──────────────┘     └────────▲──────────┘
       │                                           │
       │      bus: mcp.installed / uninstalled      │
       └───────────────────────────────────────────┘
              管理器订阅事件维护快照，不主动查 store
```

| 层 | 管什么 | 不管什么 |
|----|--------|----------|
| MCP Store | 运行配置（command/args/env）；安装/卸载 | 模板、可见性 |
| 角色模板 | MCP 清单 + 每个 MCP 的工具可见性（surface/search） | Store、运行配置 |
| MCP 管理器 | 订阅 store 事件维护快照；resolve 时模板 ∩ 快照 → 输出完整 JSON | 不查 store、不做 CRUD |

---

## 3. MCP Store

**不改**。现有接口已满足需求。管理器通过订阅 bus 事件感知变化。

---

## 4. 角色模板数据结构升级

`availableMcps` 从 `string[]` 升级为 `McpToolVisibility[]`：

```ts
interface McpToolVisibility {
  name: string;                // MCP 在 store 中的名字
  surface: string[] | '*';     // 首屏可见工具（'*' = 全部）
  search: string[] | '*';      // searchTools 可搜到的工具
}
```

DB 列不变（TEXT JSON），向后兼容：旧格式 `"mteam"` 自动解析为 `{ name: "mteam", surface: '*', search: [] }`。

---

## 5. MCP 管理器

新文件 `mcp-store/mcp-manager.ts`。

**生命周期**：server 启动时 `boot()`（从 store 拿全量 + 订阅 bus），关闭时 `teardown()`。

**核心方法**：
- `resolve(templateMcps, ctx)` → 模板清单 ∩ 内存快照 → 完整 `--mcp-config` JSON + 可见性配置
- `isAvailable(name)` → 快照里是否有
- `checkTemplate(mcps)` → 标注每个 MCP 当前是否可用

**保证**：resolve 输出的每个 MCP 一定在快照里存在。不存在的跳过记入 skipped。

---

## 6. searchTools 元工具

mteam MCP server 内部实现：

- 首屏：ListTools 返回 surface 配置的工具 + searchTools 自身
- 次屏：agent 调 searchTools(query) → 模糊匹配 → 命中工具加入激活池 → `sendToolListChanged()` → Claude 重新拉 ListTools → 新工具可直接调用
- 前提：server capabilities 声明 `tools: { listChanged: true }`

---

## 7. 角色过滤

双重过滤：
1. **硬约束**：工具注册表中 `leaderOnly` 字段，member 永远看不到
2. **软配置**：模板的 surface/search 配置，在角色过滤之后再筛

IS_LEADER env 由管理器 resolve 时注入 mteam 子进程。

---

## 8. 联动链路

**安装**：store.install → emit mcp.installed → 管理器快照新增 → 新 spawn 自动注入

**卸载**：store.uninstall → emit mcp.uninstalled → 管理器快照移除 → 新 spawn 自动跳过

**模板不清理**：卸载不删模板里的引用，装回来自动恢复。

---

## 9. 改动清单

| 类型 | 文件 | 改动 |
|------|------|------|
| 新增 | mcp-store/mcp-manager.ts | McpManager 类 |
| 新增 | mcp/tools/registry.ts | 工具注册表 + ToolEntry 类型 |
| 新增 | mcp/tools/search_tools.ts | searchTools 元工具 |
| 修改 | domain/role-template.ts | availableMcps 类型升级 + 兼容解析 |
| 修改 | mcp/config.ts | readEnv 加 isLeader + toolVisibility |
| 修改 | mcp/server.ts | ListTools/CallTool 用注册表 + 可见性过滤 |
| 修改 | pty/manager.ts | 拼接逻辑替换为调 McpManager.resolve() |
| 不改 | mcp-store/store.ts | 管理器订阅事件，不加方法 |
| 不改 | bus/types.ts | mcp 事件已存在 |

---

## 10. 实施计划

| Phase | 内容 | 依赖 |
|-------|------|------|
| 1 | 模板类型升级 + McpManager + pty/manager 重构 | 无 |
| 2 | 工具注册表 + 角色过滤 + config.ts | Phase 1 |
| 3 | searchTools + listChanged 动态注册 | Phase 2 |
| 4 | 前端模板编辑器展示 MCP 可用性（可选） | Phase 1 |
