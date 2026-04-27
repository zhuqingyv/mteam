# 文档同步报告：mteam-primary MCP + DockerRuntime

> 日期：2026-04-27
> 目的：同步所有前端/架构文档，反映两个已落地变更

---

## 变更清单

### 1. `docs/frontend-api/INDEX.md`

- **5.2 非 HTTP 通道**：新增 `/mcp/mteam-primary` 行（主 Agent 专属 MCP HTTP 入口），明确与 `/mcp/mteam`（成员/Leader 用）的区分
- **5.3 Agent MCP 工具**：拆成两张表（mteam 成员用 + mteam-primary 主 Agent 用），新增 4 个工具说明（create_leader / send_to_agent / list_addresses / get_team_status），顶部加注释说明两套 MCP 的区分

### 2. `docs/frontend-api/primary-agent-api.md`

- **mcpConfig 请求体示例**：`"serverName": "mteam"` → `"serverName": "mteam-primary"`
- **新增 MCP 注入说明块**：列出主 Agent 实际注入的 MCP 组合（mteam-primary + searchTools + mnemo），明确 mteam 不注入给主 Agent

### 3. `docs/architecture-overview.md`

- **ASCII 架构图**：扩展 mcp 区域显示 mteam / mteam-primary / searchTools 三个内置 MCP + 端口 :58591；agent 子进程分列 host 和 docker 两种模式
- **模块清单**：新增 `mcp-primary/` 模块行；`mcp-http/` 描述加入 mteam-primary 和端口 :58591；`primary-agent/` 描述更新为通过 `resolveForPrimary()` 注入；`process-runtime/` 描述加入 `TEAM_HUB_RUNTIME_KIND=docker` 切换说明和双 runtime 支持
- **设计决策 #5**：mteam/searchTools → mteam / mteam-primary / searchTools，端口 58590 → 58591（MCP HTTP 独立端口）
- **场景 C**：补充主 Agent 通过 `mteam-primary.create_leader` 建团队的流程，区分主 Agent 和 Leader 各自使用的 MCP

### 4. `packages/renderer/docs/FRONTEND-API-INDEX.md`

- **模块 2（主 Agent 状态 + 对话）**：接入要点末尾新增一条"主 Agent MCP 能力"说明，明确使用 mteam-primary + searchTools + mnemo，不使用 mteam

### 5. `docs/mteam-tools.md`

- **标题**：`mteam MCP 工具完整清单` → `mteam / mteam-primary MCP 工具完整清单`
- **新增区分表**：顶部加"两套 MCP 的区分"表格（使用方、工具数、代码位置、HTTP 路径），明确主 Agent 不使用 mteam
- **结构拆分**：原有内容归入 `Part A: mteam MCP（成员/Leader agent 用）`
- **新增 Part B**：mteam-primary MCP 完整文档，包含 4 个工具的参数定义、返回值、实现路径说明、工具矩阵

### 6. `docs/phase-primary-mcp/design.md`

- **状态**：`设计稿，待用户确认后进入实施` → `已落地（2026-04-27 实施完成，131 pass / 0 fail）`
- **待确认**：改为"已确认"，补充 3 条决议结果
- **工具数量**：registry.ts 注释和 T8 任务从"5 个工具"修正为"4 个工具"（disband_team 未纳入首版）

---

## 验证

```bash
# 目标文档中不应存在"主 Agent 用 mteam"的旧说法（排除明确否定语句）
grep -rn '主.*Agent.*mteam[^-]' docs/frontend-api/ docs/architecture-overview.md packages/renderer/docs/
# 结果：仅存在"主 Agent 不再使用 mteam"、"不注入给主 Agent"等否定表述 ✅

# mcpConfig 示例中不应有 "serverName": "mteam"（不带 -primary）
grep -rn '"mteam"' docs/frontend-api/primary-agent-api.md
# 结果：0 行 ✅
```
