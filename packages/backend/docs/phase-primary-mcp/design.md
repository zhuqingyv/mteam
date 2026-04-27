# Phase Primary MCP —— 主 Agent 专属工具集设计

> 日期：2026-04-27
> 状态：**已落地**（2026-04-27 实施完成，131 pass / 0 fail）

---

## 0. 核心概念对齐

| 角色 | 存在哪 | 谁创建它 | 存活周期 | 比喻 |
|------|--------|---------|---------|------|
| **主 Agent（Primary Agent）** | `primary_agent` 表，全局单例 | 用户启动 mteam 时自动就有 | 永远在线 | 秘书 + 总机 |
| **Leader** | `role_instances` 表，`isLeader=true` | 主 Agent 通过 `create_leader` 创建 | 一个团队生命周期 | 项目经理 |
| **成员 Agent** | `role_instances` 表 | Leader 通过 `add_member` 创建 | 一个任务生命周期 | 干活工程师 |

**主 Agent ≠ Leader。** 主 Agent 是用户的代理人，Leader 是团队的管理者。主 Agent 创建 Leader，Leader 组团干活。

---

## 1. 现状问题

当前主 Agent 用的是 mteam MCP（`send_msg` / `check_inbox` / `read_message` / `request_offline` / `add_member` 等 9 个工具）。这套工具的语义前提是"调用者是 team 内的 agent"：

- `add_member` 内部 `findSelfTeamId()` 查 `role_instances` 表 —— 主 Agent 不在这张表里，直接 403
- `check_inbox` / `read_message` 是信箱机制 —— 主 Agent 走 WS 直接和用户对话，不需要信箱
- `send_msg` 假设调用者在某个团队上下文里 —— 主 Agent 不属于任何团队

**结论**：mteam MCP 给主 Agent 用是错位的。需要一套专属工具。

---

## 2. 主 Agent MCP 工具集：mteam-primary

### 2.1 工具清单

| 工具 | 用途 | 一句话 |
|------|------|--------|
| `create_leader` | 创建 Leader 实例 + 自动建团队 | 用户说"帮我建个团队做 X" |
| `send_to_agent` | 主动给任意 agent 发消息 | 跨团队通信总机 |
| `list_addresses` | 查看所有 agent 通信地址 | 通讯录 |
| `get_team_status` | 查一个团队的健康度 | 用户问"X 团队做到哪了" |

前三个是用户明确要求的，`get_team_status` 是 UX 审查后建议补充的（避免每次问进度都要 send_to_agent ping leader）。

### 2.2 工具接口定义

#### `create_leader`

```ts
inputSchema: {
  templateName: string,   // 必填，角色模板名
  memberName: string,     // 必填，Leader 显示名
  teamName: string,       // 必填，团队名
  description?: string,   // 可选，团队描述
  task?: string,          // 可选，初始任务
}
// 返回：{ instanceId, teamId, memberName, teamName }
```

**实现路径**：`POST /api/role-instances` (isLeader) → `POST /api/teams` → `POST /api/teams/:id/members`。走 HTTP 面保证 bus 事件链完整（instance.created → roster 同步 → driver 启动 → WS 广播）。

#### `send_to_agent`

```ts
inputSchema: {
  to: string,         // 必填，address | instanceId | alias
  content: string,    // 必填，消息正文
  summary?: string,   // 可选，≤200 字符摘要
  kind?: 'chat' | 'task',  // 可选，默认 chat
  replyTo?: string,   // 可选，引用的 envelopeId
}
// 返回：{ delivered: true, envelopeId } | { error }
```

**实现路径**：复用 `CommRouter.dispatch()`，通过 `InProcessComm` 同进程调用。envelope 的 `from` 固定为主 Agent 的 `local:<primary_id>` 地址。

#### `list_addresses`

```ts
inputSchema: {
  scope?: 'all' | 'leaders' | 'members',  // 默认 all
  teamId?: string,                         // 可选，按团队过滤
}
// 返回：{ entries: [{ address, kind, displayName, instanceId, teamId?, status }], total }
```

**实现路径**：`GET /api/role-instances` + `GET /api/teams` 聚合 + 主 Agent 自身（readRow）。纯读。

#### `get_team_status`

```ts
inputSchema: {
  teamId: string,  // 必填
}
// 返回：{ teamName, leader: { name, status }, members: [{ name, status, task? }], memberCount }
```

**实现路径**：`GET /api/teams/:id` 已有，聚合返回。

---

## 3. 主 Agent 不再拥有的 MCP

| MCP | 状态 | 理由 |
|-----|------|------|
| mteam | **移除** | 成员/Leader 的工具，主 Agent 不在 role_instances |
| searchTools | **保留** | 主 Agent 也需要搜索工具能力 |
| mnemo | **保留** | 主 Agent 的记忆本，用于记住团队历史/用户偏好 |
| mteam-primary | **新增** | 本文档设计的 4 个工具 |

---

## 4. 注入方式改造

### 4.1 新增 `mcpManager.resolveForPrimary()`

不复用 `resolve()`，新建专用方法：

```ts
resolveForPrimary(templateMcps, ctx: { instanceId, hubUrl }): ResolvedMcpSet {
  specs = [];
  // 1. 无条件注入 mteam-primary builtin
  specs.push({ kind: 'builtin', name: 'mteam-primary', env: { ROLE_INSTANCE_ID, V2_SERVER_URL } });
  // 2. 无条件注入 searchTools builtin
  specs.push({ kind: 'builtin', name: 'searchTools', env: { ROLE_INSTANCE_ID, V2_SERVER_URL } });
  // 3. 遍历用户配置的 MCP，跳过 mteam，透传其他（如 mnemo）
  for (entry of templateMcps) {
    if (name === 'mteam') { skip; continue; }
    // mnemo 等 user-stdio 原样透传
    specs.push(...);
  }
  return { specs, skipped };
}
```

### 4.2 `driver-config.ts` 改动（2 行）

```diff
- const resolved = mcpManager.resolve(row.mcpConfig, { instanceId, hubUrl, commSock, isLeader: true });
+ const resolved = mcpManager.resolveForPrimary(row.mcpConfig, { instanceId, hubUrl });
```

### 4.3 MCP HTTP listener 扩展

`mcp-http/index.ts` 加一条路径 `/mcp/mteam-primary`，挂新 server。

---

## 5. 模块拆分

```
packages/backend/src/
├── mcp-primary/                        # 新增：主 Agent 专属 MCP
│   ├── server.ts                       # createMteamPrimaryServer()，~60 行
│   ├── config.ts                       # PrimaryEnv 类型，~20 行
│   └── tools/
│       ├── registry.ts                 # 4 个工具注册，~50 行
│       ├── create_leader.ts            # ~70 行
│       ├── send_to_agent.ts            # ~50 行
│       ├── list_addresses.ts           # ~60 行
│       └── get_team_status.ts          # ~40 行
│
├── mcp-http/
│   ├── index.ts                        # 改：+3 行 dispatch 加 /mcp/mteam-primary
│   └── mteam-primary-handler.ts        # 新增，~70 行
│
├── mcp-store/
│   └── mcp-manager.ts                  # 改：+30 行 resolveForPrimary()
│
└── primary-agent/
    └── driver-config.ts                # 改：2 行 resolve → resolveForPrimary
```

新增 ~420 行，修改 ~35 行。每个文件 ≤80 行，远低于 200 行红线。

---

## 6. 使用场景映射

| 用户说的话 | 主 Agent 调的工具 |
|---|---|
| "帮我建个团队做 X" | `create_leader` (1-N 次) → `send_to_agent` (kickoff) |
| "X 团队做到哪了" | `get_team_status` → 不够则 `send_to_agent` 问 leader |
| "问下 X 什么时候能给 Y" | `send_to_agent({to: X})` → 等回复 → 转述 |
| "让大家停一下" | `list_addresses({scope:'leaders'})` → 遍历 `send_to_agent` |
| "现在都有谁在干活" | `list_addresses` |

---

## 7. 与 mnemo 的配合

| 类型 | mnemo 记什么 | 工具查什么 |
|------|-------------|-----------|
| 实时状态（在线/离线/当前任务） | 不记（会过期） | `list_addresses` / `get_team_status` |
| 历史语义（团队为什么建、用户偏好、踩过的坑） | mnemo 记 | 不查 |
| 用户原话/偏好 | mnemo 记 | kickoff 时从 mnemo search 出来塞给 leader |

---

## 8. 已确认（原待确认项）

1. **`create_leader` 是否同时把 leader 加进 team_members？** — **是**，保持与 UI 流程一致
2. **MCP server 名字**：**`mteam-primary`**（已采纳）
3. **工具数量**：最终落地 4 个工具（`disband_team` 未纳入首版）

---

## 9. 实施任务拆分（建议）

| # | 任务 | 依赖 | 预估 |
|---|------|------|------|
| T1 | `mcp-primary/` 目录 + server.ts + config.ts + registry.ts 骨架 | 无 | 小 |
| T2 | `create_leader` 工具实现 + 测试 | T1 | 中 |
| T3 | `send_to_agent` 工具实现 + 测试 | T1 | 中 |
| T4 | `list_addresses` 工具实现 + 测试 | T1 | 小 |
| T5 | `get_team_status` 工具实现 + 测试 | T1 | 小 |
| T6 | `mcp-http` listener 扩展 + handler | T1 | 小 |
| T7 | `mcpManager.resolveForPrimary()` + `driver-config.ts` 改造 | T1+T6 | 小 |
| T8 | 端到端验证：主 Agent 启动后能看到 4 个工具 | T1-T7 | 小 |

T2/T3/T4/T5/T6 可并行。
