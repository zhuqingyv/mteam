# MCP 工具分层技术方案

> 日期: 2026-04-23
> 依据: `docs/mcp-tool-layering-research.md`（协议/SDK 能力调研）
> 作用范围: `packages/backend/src/mcp/`（mteam 内置 stdio MCP server）
> 推荐实施方案: 方案 E = 方案 A（IS_LEADER 角色过滤）+ 方案 C（searchTools 元工具 + sendToolListChanged 动态注册）

---

## 0. 阅读入口：一句话需求

- **agent 眼里工具是扁平列表，没有"工具集"概念** —— 所有可见性/分层控制都在 server 端完成。
- **首屏平铺核心工具** —— `tools/list` 返回每个角色当前需要的核心工具，agent 可直接调用。
- **`searchTools` 元工具**（我们自己实现，非 Claude Code 内置）—— agent 搜索 → server 把命中工具加入"已激活"池 → 发 `notifications/tools/list_changed` → Claude Code 重新 `tools/list` → 工具即刻可调用。
- **角色分层** —— `IS_LEADER` env 决定哪些工具出现在首屏、哪些工具可被 `searchTools` 搜到。
- **与 `availableMcps` 互不干扰** —— `availableMcps` 决定 mteam、mnemo 等**整个 MCP server**是否被 spawn；工具分层决定 **mteam 一个 server 内部**哪些工具可见。

---

## 1. 工具清单设计

工具分为四个组（group）；每个工具登记 **visibility**（谁能看到）和 **exposure**（首屏 / 搜索）。

### 1.1 可见性维度

| 字段 | 取值 | 含义 |
|---|---|---|
| `visibility` | `"both"` / `"leader"` / `"member"` | 谁的 server 里存在这条工具。`member` 的 server 不应在运行时任何路径暴露 `leader` 专属工具 |
| `exposure` | `"surface"` / `"search"` | `surface` 首屏直接出现在 `tools/list`；`search` 必须通过 `searchTools` 发现并激活 |
| `group` | `"core"` / `"team"` / `"project"` / `"mcp_store"` | 分组标识。用于 `searchTools` 的 `category` 过滤 |

### 1.2 完整工具表

> 标记：
> - **[已实现]**：当前 `packages/backend/src/mcp/tools/` 下已存在
> - **[P2]**：Phase 2 新增（team / project 相关，本方案一并列出 schema 见 §7）
> - **[P3]**：Phase 3 新增（mcp_store 相关，延后）

| 工具名 | group | visibility | exposure | 状态 | 说明 |
|---|---|---|---|---|---|
| `activate` | core | both | surface | 已实现 | CLI 启动第一步，自我激活 |
| `deactivate` | core | both | surface | 已实现 | 自我下线（需 PENDING_OFFLINE） |
| `send_msg` | core | both | surface | 已实现 | 发消息（alias / address 均可） |
| `check_inbox` | core | both | surface | 已实现 | 拉未读消息 |
| `lookup` | core | both | surface | 已实现 | 按 alias 查 address |
| `searchTools` | core | both | surface | **P1 新增** | 元工具。按 keyword/category 搜索可用工具并激活 |
| `request_offline` | team | leader | surface | 已实现 | 批准成员下线（原属 core，改到 team 组） |
| `create_member` | team | leader | surface | P2 | 创建成员 instance（spawn CLI） |
| `list_team` | team | leader | surface | P2 | 列出当前 team 成员 + 状态 |
| `create_team` | team | leader | search | P2 | 创建 team（leader→新 team） |
| `disband_team` | team | leader | search | P2 | 解散当前 team |
| `add_member` | team | leader | search | P2 | 把已有 instance 加入 team |
| `remove_member` | team | leader | search | P2 | 踢人 |
| `rename_member` | team | leader | search | P2 | 改成员 alias（兼容备注名） |
| `create_project` | project | leader | search | P2 | 创建 project（预留，model 未落地） |
| `list_projects` | project | leader | search | P2 | 列出 projects |
| `assign_project` | project | leader | search | P2 | 把 team 绑到 project |
| `install_mcp` | mcp_store | leader | search | P3 | 给某 instance 安装一个 MCP（需重启 instance 生效） |
| `uninstall_mcp` | mcp_store | leader | search | P3 | 卸载 MCP |
| `list_mcp_store` | mcp_store | leader | search | P3 | 列出可用 MCP |

### 1.3 分组即权限的边界

- **core**：所有角色共享，首屏出现。这个组保证 agent 最小可用（登场 → 通信 → 下线）。
- **team**：leader 专属管理能力。成员 server 里**根本不注册**这些工具，`searchTools` 也搜不到。
- **project / mcp_store**：同 team，leader 专属，搜索激活。
- **扩展原则**：新增 member 专属工具时直接登记 `visibility: "member"`；新增所有人共用工具登记 `visibility: "both"`。

---

## 2. 首屏工具名单

### 2.1 leader 首屏（`tools/list` 首次返回）

```
activate, deactivate, send_msg, check_inbox, lookup,
searchTools, request_offline, create_member, list_team
```

**为什么放首屏**：
- `activate / deactivate / send_msg / check_inbox / lookup`：agent 日常最高频，缺一不可。
- `searchTools`：分层入口，必须首屏。
- `request_offline / create_member / list_team`：leader 管理成员的最高频路径（批准下线 / 拉新人 / 看团队状态），每次会话大概率被用到。

### 2.2 member 首屏

```
activate, deactivate, send_msg, check_inbox, lookup, searchTools
```

**为什么**：
- 只剩 core + `searchTools`。
- 成员不管理团队，不需要 `request_offline`（不是成员能调的）。
- `searchTools` 对成员是**降级的**：只能搜到 `visibility in ("both", "member")` 的工具，搜不到任何 leader 专属工具。当前 member 专属组为空 → 成员搜任何关键词都只会返回 core 里已在首屏的工具（即 "no new tool to activate"）。

### 2.3 首屏 token 预算

- 当前 core 6 工具 schema 合计约 1.2k tokens，加 `searchTools` 后约 1.5k。
- leader 首屏 9 工具约 2.2k tokens，在可接受范围内。
- P2 上线 `create_member / list_team` 后，leader 首屏仍 ≤ 3k tokens。

---

## 3. `searchTools` 实现方案

### 3.1 Schema

```ts
export const searchToolsSchema = {
  name: 'searchTools',
  description:
    'Search available tools by keyword or category. Matching tools are IMMEDIATELY activated and returned; you can call them directly after this response. Repeat calls are idempotent.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Keyword matched against tool name and description (case-insensitive, substring). Optional.',
      },
      category: {
        type: 'string',
        enum: ['core', 'team', 'project', 'mcp_store', 'all'],
        description: 'Filter by tool group. Optional. Defaults to "all".',
      },
    },
    additionalProperties: false,
  },
};
```

**要点**：
- `query` 和 `category` 都是可选，但至少传一个（两个都空时返回错误提示，避免 agent 拉全量）。
- description 里显式告诉 agent："工具**已经**激活了，直接调即可"。避免 agent 再去 listTools 确认。

### 3.2 工具注册表结构

新建 `packages/backend/src/mcp/tools/registry.ts`：

```ts
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type ToolGroup = 'core' | 'team' | 'project' | 'mcp_store';
export type ToolVisibility = 'both' | 'leader' | 'member';
export type ToolExposure = 'surface' | 'search';

export interface ToolEntry {
  schema: Tool;
  group: ToolGroup;
  visibility: ToolVisibility;
  exposure: ToolExposure;
  // handler 在 server.ts 集中分发（不放这里避免循环依赖）
}

export const TOOL_REGISTRY: Record<string, ToolEntry> = {
  activate:        { schema: activateSchema,        group: 'core', visibility: 'both',   exposure: 'surface' },
  deactivate:      { schema: deactivateSchema,      group: 'core', visibility: 'both',   exposure: 'surface' },
  send_msg:        { schema: sendMsgSchema,         group: 'core', visibility: 'both',   exposure: 'surface' },
  check_inbox:     { schema: checkInboxSchema,      group: 'core', visibility: 'both',   exposure: 'surface' },
  lookup:          { schema: lookupSchema,          group: 'core', visibility: 'both',   exposure: 'surface' },
  searchTools:     { schema: searchToolsSchema,     group: 'core', visibility: 'both',   exposure: 'surface' },
  request_offline: { schema: requestOfflineSchema,  group: 'team', visibility: 'leader', exposure: 'surface' },
  // P2:
  // create_member: { ..., group: 'team', visibility: 'leader', exposure: 'surface' },
  // list_team:     { ..., group: 'team', visibility: 'leader', exposure: 'surface' },
  // create_team:   { ..., group: 'team', visibility: 'leader', exposure: 'search' },
  // ...
};

export function canSee(entry: ToolEntry, isLeader: boolean): boolean {
  if (entry.visibility === 'both') return true;
  return entry.visibility === (isLeader ? 'leader' : 'member');
}
```

### 3.3 可见池 vs 激活池

server 运行时维护两个派生集合：

```ts
// 进程级 state（每个 mteam stdio 子进程独立）
const visiblePool: Set<string>   = names(TOOL_REGISTRY).filter(n => canSee(TOOL_REGISTRY[n], env.isLeader));
const activatedPool: Set<string> = names(TOOL_REGISTRY).filter(n => visiblePool.has(n) && TOOL_REGISTRY[n].exposure === 'surface');
```

**规则**：
- `visiblePool`：角色能访问的所有工具（根据 `visibility` 过滤后）；静态，spawn 即定。
- `activatedPool`：真正出现在 `tools/list` 返回里的工具；初始 = visiblePool ∩ exposure=surface；`searchTools` 运行时往里加。
- `activatedPool ⊆ visiblePool` —— `searchTools` 绝不会激活 member 看不见的 leader 工具。

### 3.4 ListTools handler

```ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Array.from(activatedPool).map(name => TOOL_REGISTRY[name].schema),
}));
```

### 3.5 searchTools 匹配逻辑

```ts
function matchQuery(entry: ToolEntry, name: string, query: string | undefined): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return name.toLowerCase().includes(q)
      || entry.schema.description.toLowerCase().includes(q);
}

async function runSearchTools(args: { query?: string; category?: string }, env: MteamEnv): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const category = (typeof args.category === 'string' ? args.category : 'all') as ToolGroup | 'all';
  if (!query && category === 'all') {
    return { error: 'provide at least one of: query, category' };
  }

  const hits: Array<{ name: string; description: string; group: ToolGroup; alreadyActive: boolean }> = [];
  const newlyActivated: string[] = [];

  for (const name of visiblePool) {
    const entry = TOOL_REGISTRY[name];
    if (category !== 'all' && entry.group !== category) continue;
    if (!matchQuery(entry, name, query)) continue;
    const alreadyActive = activatedPool.has(name);
    hits.push({ name, description: entry.schema.description, group: entry.group, alreadyActive });
    if (!alreadyActive) {
      activatedPool.add(name);
      newlyActivated.push(name);
    }
  }

  if (newlyActivated.length > 0) {
    await server.sendToolListChanged(); // 触发 Claude Code 重拉 tools/list
  }

  return {
    matched: hits.length,
    newly_activated: newlyActivated,
    tools: hits,
    hint: newlyActivated.length > 0
      ? 'Tools are now active. Call them directly.'
      : 'No new tools activated (all matches were already active or no matches).',
  };
}
```

**匹配规则**：
- `query` 对 `name` 和 `description` 做**大小写无关子串匹配**。不做分词 / 正则 / fuzzy，保持简单可预测。
- `category = 'all'` + 无 `query` → 报错；不允许"拉全量"。
- `category != 'all'` + 无 `query` → 返回该组全部可见工具（相当于按组批量激活，常见用法：`searchTools({category: 'team'})`）。

### 3.6 agent 调用流程

```
[启动]
  Claude Code → mteam.tools/list → [activate, deactivate, send_msg, check_inbox, lookup, searchTools, ...]
  agent 看到扁平工具列表

[正常调用]
  agent → call activate → OK
  agent → call check_inbox → messages
  agent → call send_msg → delivered

[需要未激活的工具]
  agent → call searchTools({category: 'team'})
  mteam:
    1. 匹配 visiblePool 里 group='team' 的工具
    2. activatedPool += 命中项
    3. sendToolListChanged()
    4. 返回 {matched, newly_activated, tools, hint}
  Claude Code 收到 list_changed 通知 → 重新 tools/list → 拿到扩展后的工具集
  agent → call create_team({...}) → 直接成功
```

### 3.7 关键 invariant

1. `activatedPool ⊆ visiblePool`：永远成立。`searchTools` 只在 visiblePool 里匹配。
2. **member 无法通过 searchTools 获取 leader 工具**：因为 member 的 visiblePool 里根本没有这些工具。
3. **幂等**：重复激活同一工具不触发重复 `sendToolListChanged`（通过 `newlyActivated.length > 0` 门控）。
4. **进程级隔离**：`activatedPool` 是 mteam stdio 子进程的局部变量；每个成员一个子进程，互不影响。进程退出即清零。

---

## 4. 角色过滤实现

### 4.1 `config.ts` 改动

新增 `isLeader` 字段：

```ts
export interface MteamEnv {
  instanceId: string;
  hubUrl: string;
  commSock: string;
  isLeader: boolean; // 新增
}

export function readEnv(): MteamEnv {
  // ... existing ...
  const isLeader = process.env.IS_LEADER === '1';
  return { instanceId, hubUrl, commSock, isLeader };
}
```

> `IS_LEADER` env 已经在 `packages/backend/src/pty/manager.ts:116` 注入到子进程。

### 4.2 ListTools handler

```ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Array.from(activatedPool).map(name => TOOL_REGISTRY[name].schema),
}));
```

`activatedPool` 初始化时已经过 `canSee(entry, env.isLeader)` 过滤，因此 leader / member 的 `tools/list` 天然不同。

### 4.3 searchTools 的角色过滤

`runSearchTools` 遍历的是 `visiblePool`；visiblePool 本身已经按角色过滤。member 搜不到任何 leader 工具。

### 4.4 CallTool 的兜底防御

```ts
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (!activatedPool.has(name)) {
    return toTextResult({ error: `tool '${name}' is not activated. Use searchTools to discover and activate it.` });
  }
  // ... dispatch ...
});
```

**为什么兜底**：
- MCP spec 约定 client 只能调 ListTools 中的工具。但 Claude Code 的 tool schema 缓存 + agent 记忆可能导致调未激活工具；必须明确报错引导 `searchTools`。
- **绝不**根据 name 走注册表去触发未激活工具——那会绕过 searchTools 的激活显式语义。

---

## 5. 与现有 `availableMcps` 的关系

### 5.1 两层语义

| 层级 | 控制点 | 粒度 | 改动点 |
|---|---|---|---|
| **第一层**：MCP server 级 | `role_templates.available_mcps` | 决定一个 instance 的子进程是否加载 `mteam` / `mnemo` / 其他 MCP server | `pty/manager.ts` spawn 时组装 `--mcp-config` JSON |
| **第二层**：tool 级（本方案） | `IS_LEADER` env + `TOOL_REGISTRY` + `activatedPool` | 决定 mteam 这一个 server 暴露哪些工具 | `mcp/server.ts` ListTools handler + `searchTools` |

### 5.2 互不干扰

- 如果角色模板不包含 `mteam` → mteam 子进程根本不 spawn，第二层无效。
- 如果包含 `mteam` → mteam spawn，第二层生效，`IS_LEADER` 决定看什么。
- 本方案**不修改** `availableMcps` 的任何字段、数据结构、API。role-template.ts 保持原样。

### 5.3 未来可选增强（不在本期）

P4 若要给"工具级别"开关（例如 leader 想禁用某个 team 工具），可考虑在 `role_templates` 加 `disabledTools: string[]`，在 visiblePool 构造时过滤。目前不做。

---

## 6. 具体改动清单

### 6.1 新增文件

| 路径 | 作用 | 行数估算 |
|---|---|---|
| `packages/backend/src/mcp/tools/registry.ts` | 工具注册表、分类常量、`canSee` helper | ~60 |
| `packages/backend/src/mcp/tools/search_tools.ts` | `searchToolsSchema` + `runSearchTools` | ~80 |
| `packages/backend/src/__tests__/mcp/tool-layering.test.ts` | 单测：leader/member 首屏、searchTools 激活、跨角色越权 | ~150 |

### 6.2 修改文件

| 路径 | 修改 | 行数估算 |
|---|---|---|
| `packages/backend/src/mcp/config.ts` | `MteamEnv` 加 `isLeader`，`readEnv` 读 `IS_LEADER` env | +3 |
| `packages/backend/src/mcp/server.ts` | capabilities 加 `listChanged: true`；用 `activatedPool` 替代 `TOOL_SCHEMAS`；dispatch 改 registry 查表；加 `searchTools` case；CallTool 加激活门控 | ~60 变更 |

### 6.3 代码骨架

#### registry.ts

```ts
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { activateSchema }        from './activate.js';
import { deactivateSchema }      from './deactivate.js';
import { sendMsgSchema }         from './send_msg.js';
import { checkInboxSchema }      from './check_inbox.js';
import { lookupSchema }          from './lookup.js';
import { requestOfflineSchema }  from './request_offline.js';
import { searchToolsSchema }     from './search_tools.js';

export type ToolGroup = 'core' | 'team' | 'project' | 'mcp_store';
export type ToolVisibility = 'both' | 'leader' | 'member';
export type ToolExposure = 'surface' | 'search';

export interface ToolEntry {
  schema: Tool;
  group: ToolGroup;
  visibility: ToolVisibility;
  exposure: ToolExposure;
}

export const TOOL_REGISTRY: Record<string, ToolEntry> = {
  activate:        { schema: activateSchema,       group: 'core', visibility: 'both',   exposure: 'surface' },
  deactivate:      { schema: deactivateSchema,     group: 'core', visibility: 'both',   exposure: 'surface' },
  send_msg:        { schema: sendMsgSchema,        group: 'core', visibility: 'both',   exposure: 'surface' },
  check_inbox:     { schema: checkInboxSchema,     group: 'core', visibility: 'both',   exposure: 'surface' },
  lookup:          { schema: lookupSchema,         group: 'core', visibility: 'both',   exposure: 'surface' },
  searchTools:     { schema: searchToolsSchema,    group: 'core', visibility: 'both',   exposure: 'surface' },
  request_offline: { schema: requestOfflineSchema, group: 'team', visibility: 'leader', exposure: 'surface' },
};

export function canSee(entry: ToolEntry, isLeader: boolean): boolean {
  if (entry.visibility === 'both') return true;
  return entry.visibility === (isLeader ? 'leader' : 'member');
}

export function initialVisiblePool(isLeader: boolean): Set<string> {
  return new Set(Object.entries(TOOL_REGISTRY)
    .filter(([, e]) => canSee(e, isLeader))
    .map(([n]) => n));
}

export function initialActivatedPool(visible: Set<string>): Set<string> {
  return new Set(Array.from(visible).filter(n => TOOL_REGISTRY[n].exposure === 'surface'));
}
```

#### search_tools.ts

```ts
import type { ToolGroup } from './registry.js';

export const searchToolsSchema = {
  name: 'searchTools',
  description:
    'Search available tools by keyword or category. Matching tools are IMMEDIATELY activated and returned; you can call them directly after this response. Repeat calls are idempotent.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Keyword matched against tool name and description (case-insensitive, substring). Optional.' },
      category: {
        type: 'string',
        enum: ['core', 'team', 'project', 'mcp_store', 'all'],
        description: 'Filter by tool group. Optional. Defaults to "all".',
      },
    },
    additionalProperties: false,
  },
};

export interface SearchCtx {
  visiblePool: Set<string>;
  activatedPool: Set<string>;
  onActivated: () => Promise<void>; // 由 server.ts 注入，内部调 sendToolListChanged()
}

export async function runSearchTools(
  args: { query?: unknown; category?: unknown },
  ctx: SearchCtx,
  registry: import('./registry.js').ToolEntry extends never ? never : typeof import('./registry.js').TOOL_REGISTRY,
): Promise<unknown> {
  // ... 见 §3.5 ...
}
```

> 实施时 registry 直接 import 即可，无需通过参数传。上面签名只是示意。

#### server.ts（关键片段）

```ts
const server = new Server(
  { name: 'mteam', version: '0.1.0' },
  { capabilities: { tools: { listChanged: true } } }, // 改动 1
);

const visiblePool = initialVisiblePool(env.isLeader);
const activatedPool = initialActivatedPool(visiblePool);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Array.from(activatedPool).map(n => TOOL_REGISTRY[n].schema),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  if (!activatedPool.has(name)) {
    return toTextResult({ error: `tool '${name}' not activated. Use searchTools to discover and activate it.` });
  }
  try {
    switch (name) {
      case 'activate':        return toTextResult(await runActivate(env));
      case 'deactivate':      return toTextResult(await runDeactivate(env));
      case 'send_msg':        return toTextResult(await runSendMsg(env, comm, args));
      case 'check_inbox':     return toTextResult(await runCheckInbox(env, args));
      case 'lookup':          return toTextResult(await runLookup(env, args));
      case 'request_offline': return toTextResult(await runRequestOffline(env, args));
      case 'searchTools':     return toTextResult(await runSearchTools(args, {
        visiblePool,
        activatedPool,
        onActivated: () => server.sendToolListChanged(),
      }));
      default:
        return toTextResult({ error: `unknown tool: ${name}` });
    }
  } catch (e) {
    return toTextResult({ error: (e as Error).message });
  }
});
```

---

## 7. 待实现的新工具 schema（P2）

> 以下 schema 供后续 P2 实施 agent 参考。**每个工具都需要配套 handler、HTTP API（若涉及跨 instance 写操作）、单测**。
> 本方案只列 schema 与交互契约，**不给 handler 实现**。

### 7.1 team 组

#### `create_member`（leader 专属，surface）

```ts
export const createMemberSchema = {
  name: 'create_member',
  description:
    'Leader-only. Create a new member role_instance under current leader, spawn the CLI, optionally attach a persona task. Returns the new instanceId and alias.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      templateName: { type: 'string', description: 'role_template name (must exist in role_templates).' },
      memberName:   { type: 'string', description: 'Display alias, e.g. "frontend-dev-1".' },
      task:         { type: 'string', description: 'Optional initial task injected into system prompt.' },
    },
    required: ['templateName', 'memberName'],
    additionalProperties: false,
  },
};
```

契约：
- HTTP 调 `POST /api/role-instances`，body `{ templateName, memberName, isLeader: false, leaderName: <caller.memberName>, teamId: <caller.teamId ?? null>, task }`
- 返回 `{ instanceId, alias, status }`
- 错误：模板不存在 / alias 冲突 / 非 leader 调用

#### `list_team`（leader 专属，surface）

```ts
export const listTeamSchema = {
  name: 'list_team',
  description:
    'Leader-only. List current team members with status, alias, template, and last heartbeat. Returns empty array if leader has no active team.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
};
```

契约：
- HTTP 先 `GET /api/teams?leaderInstanceId=<self>` 查当前 ACTIVE team；无则返回 `{ team: null, members: [] }`
- 有 team → `GET /api/teams/:id/members` + join role_instances 拿 status/alias

#### `create_team`（leader 专属，search）

```ts
export const createTeamSchema = {
  name: 'create_team',
  description:
    'Leader-only. Create a new team with self as leader. Fails if leader already has an ACTIVE team.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name:        { type: 'string', description: 'Team display name.' },
      description: { type: 'string', description: 'Optional team description.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};
```

HTTP：`POST /api/teams` body `{ name, description, leaderInstanceId: <self> }`。现有 `packages/backend/src/api/panel/teams.ts:handleCreateTeam` 已实现。

#### `disband_team`（leader 专属，search）

```ts
export const disbandTeamSchema = {
  name: 'disband_team',
  description:
    'Leader-only. Disband current ACTIVE team (soft delete). Cascade: all members go to PENDING_OFFLINE.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
};
```

#### `add_member`（leader 专属，search）

```ts
export const addMemberSchema = {
  name: 'add_member',
  description:
    'Leader-only. Add an existing role_instance to current ACTIVE team. Instance must be in PENDING or ACTIVE state and not already in another team.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      instanceId: { type: 'string', description: 'Target role_instance id.' },
      roleInTeam: { type: 'string', description: 'Optional role label in this team.' },
    },
    required: ['instanceId'],
    additionalProperties: false,
  },
};
```

#### `remove_member`（leader 专属，search）

```ts
export const removeMemberSchema = {
  name: 'remove_member',
  description:
    'Leader-only. Remove a member from current ACTIVE team. Cascade: member goes to PENDING_OFFLINE.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      instanceId: { type: 'string' },
    },
    required: ['instanceId'],
    additionalProperties: false,
  },
};
```

#### `rename_member`（leader 专属，search）

```ts
export const renameMemberSchema = {
  name: 'rename_member',
  description:
    'Leader-only. Rename the alias/member_name of an instance in the current team. Used when the leader wants a more memorable nickname than the spawn-time alias.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      instanceId: { type: 'string' },
      newAlias:   { type: 'string' },
    },
    required: ['instanceId', 'newAlias'],
    additionalProperties: false,
  },
};
```

> 注：需要对应后端新增 `PATCH /api/role-instances/:id/alias`，目前不存在。

### 7.2 project 组

#### `create_project`（leader 专属，search）

```ts
export const createProjectSchema = {
  name: 'create_project',
  description:
    'Leader-only. Create a Project (higher-level container than team). NOT IMPLEMENTED on backend yet; schema reserved.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name:        { type: 'string' },
      description: { type: 'string' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};
```

> project 模型尚未落库（PROGRESS.md 里只列为"待做"）。注册到 TOOL_REGISTRY 时标 `exposure: 'search'`，先打桩，backend 实现前 handler 直接返回 `{ error: 'not implemented' }`。

#### `list_projects` / `assign_project`

同上，预留。

### 7.3 mcp_store 组（P3）

略。先留占位 `install_mcp / uninstall_mcp / list_mcp_store`，P3 再实现。

---

## 8. 实施计划

### Phase 1：基础设施（~2 小时，可独立测试交付）

目标：agent 首屏角色不同，`searchTools` 能动态激活现有工具。

1. **config.ts** 加 `isLeader` 字段（+3 行）。
2. **registry.ts** 新建，登记现有 7 个工具（6 老 + searchTools 占位）。
3. **search_tools.ts** 新建，实现 `runSearchTools`。
4. **server.ts** 重构：capabilities 加 `listChanged`、ListTools 用 activatedPool、CallTool 加门控、加 searchTools dispatch。
5. **把 `request_offline` 从首屏 core 逻辑改到 team 组 leader-only 首屏**（registry 登记完成即自动生效）。
6. **单测**：
   - leader / member spawn 后 tools/list 对比。
   - member 调 `searchTools({query: 'team'})` → 返回 0 命中。
   - leader 调 `searchTools({category: 'team'})` → 激活 request_offline（P1 暂只有这一个）、后续 tools/list 包含。
   - 调未激活的工具 → 明确错误。
   - 幂等：重复激活不报错、不重复发 list_changed。

**交付标志**：新加 `packages/backend/src/__tests__/mcp/tool-layering.test.ts` 全绿；`bun run dev` + 手动起 leader instance 通过 `searchTools` 能激活 `request_offline`。

### Phase 2：team 工具补全（~4 小时）

目标：leader 通过 mteam 能完整管理团队。

1. 新建 `tools/create_member.ts / list_team.ts / create_team.ts / disband_team.ts / add_member.ts / remove_member.ts`。
2. 每个工具实现 `run*` → HTTP 调 `packages/backend/src/api/panel/`（已有的 handler 直接复用）。
3. `rename_member`：需要后端新增 `PATCH /api/role-instances/:id/alias` handler + domain 层 `setMemberName()`；本工具依赖这个先做。
4. registry.ts 逐条登记。
5. 单测扩充：每个工具 happy path + 角色越权 + 错误路径。

**交付标志**：Playwright e2e 增加 "leader spawn → searchTools → create_member → list_team → check member activated" 端到端用例。

### Phase 3：MCP Store 集成（~2 小时）

目标：leader 能运行时给成员安装/卸载 MCP。

1. 工具组 `mcp_store` 下 `install_mcp / uninstall_mcp / list_mcp_store`。
2. 注意：install 后当前 instance 进程的 `--mcp-config` 已经冻结，需要 **重启 instance** 才能生效。工具 description 里必须明确告诉 agent 这个限制；返回结果里标 `requiresRestart: true`。
3. 与 `packages/backend/src/mcp-store/store.ts` 对接。

### Phase 4（可选）：tool 级可配置

若 Phase 1-3 上线后发现 leader 想临时屏蔽某工具，加 `role_templates.disabledTools` 字段，visiblePool 构造时过滤。

---

## 9. 风险与取舍

| 风险 | 影响 | 对策 |
|---|---|---|
| Claude Code 对 `tools/list_changed` 的重拉延迟 | agent 调用 `create_team` 时 tool 尚未进 schema → `tools/call` 失败 | `searchTools` 返回体里显式标注 `newly_activated`，agent 可在下一轮 tool call 里用；SDK 已验证 list_changed 会立刻触发 re-list |
| searchTools 返回大量命中 → response token 过大 | 首次无约束搜索爆 context | `query + category` 至少一个必填；单次响应截断到 20 条命中 |
| 注册表与 handler 不同步 | 登记但漏 handler → call 时 `unknown tool` | Phase 1 的 registry 与 server.ts switch 保持在同一 PR 一起改，CI 加一条静态断言：`Object.keys(TOOL_REGISTRY)` ⊆ switch case 集合 |
| 进程级 state 导致成员重启丢激活 | 成员 CLI 重启后要重新 searchTools | 不是问题：成员重启相当于新 session，重新发现工具才是正确语义 |
| member 通过 name 猜出 leader 工具去调 | 越权 | CallTool 的 `!activatedPool.has(name)` 拦截 + visiblePool 从 registry 过滤，两道防线。且 error 信息不泄漏该工具在 leader 那里存在 |

---

## 10. 与调研文档的关系

本文档是 `docs/mcp-tool-layering-research.md` 推荐方案 E 的**落地详设**：

- 调研产出"方案 E = A + C"的结论和伪代码。
- 本方案：给出注册表结构、visiblePool / activatedPool 的抽象、`searchTools` 的具体 schema 和匹配规则、新工具清单、改动清单、Phase 拆分。
- 差异 1：调研里 meta-tool 名叫 `enable_tools`，本方案用户明确要求叫 **`searchTools`**（且语义扩充：不止按 group 启用，还按 keyword 搜索）。
- 差异 2：本方案新增 **member-visible but search-only** 的能力（visibility + exposure 二维独立），比调研更细。

实施者应同时阅读：
1. `docs/mcp-tool-layering-research.md` —— 为什么选这个方向（协议层证据）。
2. 本文档 —— 怎么落地（代码级）。
