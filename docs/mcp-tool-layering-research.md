# MCP 工具分层/懒加载方案调研

> 日期: 2026-04-23
> SDK 版本: @modelcontextprotocol/sdk 1.29.0 (MCP spec 2025-03-26)
> Claude Code 版本: 2.1.118

---

## 一、MCP 协议层调研结论

### 1.1 ListTools 支持动态返回

`Server.setRequestHandler(ListToolsRequestSchema, handler)` 的 handler 是普通 async 函数，每次 `tools/list` 请求都会重新执行。可以在 handler 内根据任意条件（env 变量、运行时状态）动态过滤返回的工具列表。

当前项目代码（`packages/backend/src/mcp/server.ts:43`）：

```ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_SCHEMAS }));
```

改成条件过滤是零成本的。

### 1.2 ListTools 原生支持分页

MCP spec 明确规定 `tools/list` 支持 cursor-based pagination：

- **请求**: `ListToolsRequestSchema` 继承 `PaginatedRequestSchema`，包含可选 `cursor` 字段
- **响应**: `ListToolsResultSchema` 继承 `PaginatedResultSchema`，包含可选 `nextCursor` 字段
- **page size** 由 server 决定，client 不得假设固定大小

SDK types.js 第 1277-1284 行：

```js
export const ListToolsRequestSchema = PaginatedRequestSchema.extend({
    method: z.literal('tools/list')
});
export const ListToolsResultSchema = PaginatedResultSchema.extend({
    tools: z.array(ToolSchema)
});
```

但实际上 **Claude Code 客户端在连接时会一次性拉取所有工具**（可能自动翻页），然后缓存。分页更多是为了大列表传输优化，不是为了"首屏只展示部分工具"的懒加载目的。

### 1.3 tools/list_changed 通知 — 已被 Claude Code 支持

Server 可以发送 `notifications/tools/list_changed` 通知客户端重新拉取工具列表。

**SDK Server 端**（`server/index.js:433-435`）：

```ts
async sendToolListChanged() {
    return this.notification({ method: 'notifications/tools/list_changed' });
}
```

**前提**: 服务端声明 `capabilities: { tools: { listChanged: true } }`。

**Claude Code 支持情况**: changelog 确认 "Added support for MCP `list_changed` notifications, allowing MCP servers to dynamically update their available tools, prompts, and resources without requiring reconnection"。Claude Code 收到通知后会重新调用 `tools/list` 并刷新可用工具集。

SDK Client 端（`client/index.js:121-125`）处理逻辑：

```js
this._setupListChangedHandler('tools', ToolListChangedNotificationSchema, config.tools, async () => {
    const result = await this.listTools();
    return result.tools;
});
```

### 1.4 McpServer 高级 API 的 enable/disable

SDK 的 `McpServer`（高级 API，区别于低级 `Server`）内置了 tool 的 enable/disable/remove 机制：

```js
const registeredTool = mcpServer.tool('my_tool', ...);
registeredTool.disable();  // 从 ListTools 隐藏
registeredTool.enable();   // 重新显示
// disable/enable 自动触发 sendToolListChanged()
```

`ListTools` handler 内部自动过滤 `tool.enabled === false` 的工具。每次 enable/disable 都自动发 `tools/list_changed` 通知。

### 1.5 Claude Code 的 ToolSearch（Deferred Tools）机制

**关键发现**: Claude Code v2.1+ 内置了 deferred tool loading 机制。当 MCP server 暴露大量工具时，Claude Code 可以：

1. 初始连接时只加载部分工具的名字（不加载完整 schema）
2. 在 system-reminder 中提示 agent："The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded"
3. Agent 需要用某个 deferred tool 时，调用内置 `ToolSearch` 工具按名字或关键词搜索，获取完整 schema
4. Schema 加载后，该工具变成可调用状态

这是 **Claude Code 客户端侧的优化**，不是 MCP 协议层的功能。

### 1.6 社区讨论（已被拒绝的 SEP）

- **SEP-1300: Tool Filtering with Groups and Tags** — 在 `tools/list` 中加 filter 参数（groups + tags），2025-12 被拒。原因：可以用 annotations 替代。
- **RFC #2376: lazyRegistration** — 客户端声明 `lazyRegistration` 能力，defer `tools/list` 调用到激活时。2026-03 关闭，未合入 spec。讨论中指出 Claude Code 已有 `defer loading: true` 的客户端实现。

**结论**: MCP spec 本身不打算在协议层加工具过滤/懒加载，倾向让客户端自己处理。

---

## 二、方案设计

### 方案 A：ListTools 按角色过滤（全量返回）

**实现方式**:

在 `readEnv()` 中读取 `IS_LEADER` 环境变量（已经在 `pty/manager.ts:117` 传入），ListTools handler 根据角色返回不同工具集。

```ts
const env = readEnv(); // 新增 isLeader 字段

// 工具分两个池
const CORE_TOOLS = [activateSchema, deactivateSchema, ...];
const LEADER_TOOLS = [createTeamSchema, assignTaskSchema, ...];
const MEMBER_TOOLS = [reportProgressSchema, ...];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: env.isLeader
    ? [...CORE_TOOLS, ...LEADER_TOOLS]
    : [...CORE_TOOLS, ...MEMBER_TOOLS]
}));
```

| 维度 | 评价 |
|------|------|
| 优势 | 极简，零依赖，纯服务端逻辑，5 分钟改完 |
| 劣势 | 不解决首屏 token 问题——工具增多后全量 schema 仍然会挤占 context |
| 改动量 | ~20 行（config.ts + server.ts） |
| 需要客户端配合 | 否 |
| 适用场景 | 工具总数 < 15 且需要角色隔离时 |

### 方案 B：search_tools 元工具（应用层懒加载）

**实现方式**:

ListTools 只返回 5-6 个核心工具 + 1 个 `search_tools` 元工具。Agent 需要其他工具时，调用 `search_tools("team management")` → 返回匹配工具的完整 schema → agent 拿到 schema 后调用 `tools/call` 执行。

```ts
const searchToolsSchema = {
  name: 'search_tools',
  description: 'Search available tools by keyword. Returns tool schemas that match the query. Use this to discover tools beyond the core set.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keyword, e.g. "team", "project", "mcp store"' },
      category: { type: 'string', enum: ['team', 'project', 'mcp', 'all'], description: 'Filter by category' }
    },
    required: ['query']
  }
};

// CallTool handler
case 'search_tools': {
  const results = ALL_TOOLS
    .filter(t => matchesQuery(t, args.query, args.category))
    .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  return toTextResult({ tools: results, hint: 'Use tools/call with the tool name and arguments to invoke.' });
}
```

**关键问题**: Agent 拿到 schema 后不能直接 `tools/call`，因为 Claude Code 只允许调用 ListTools 中注册过的工具。**search_tools 返回的是 text 内容，不是注册新工具**。

**变体 B2**: search_tools 返回 schema 后，server 通过 `sendToolListChanged()` 把搜到的工具动态注册到 ListTools 中。但这需要 server 维护状态，且 Claude Code 需要重新拉取工具列表。

| 维度 | 评价 |
|------|------|
| 优势 | 首屏 token 极低（只有 6-7 个工具 schema） |
| 劣势 | **Agent 无法直接调用搜到的工具**——MCP 协议要求工具必须在 ListTools 中注册。需要额外的 `tools/list_changed` 配合（变体 B2），或者 search_tools 本身只是信息查询，agent 还得通过 `call_tool` 包装器间接调用 |
| 改动量 | ~80 行（新增 search_tools + 工具注册表 + 调度逻辑） |
| 需要客户端配合 | B1 不需要但也没真正解决问题；B2 需要客户端支持 tools/list_changed（Claude Code 已支持） |
| 适用场景 | 工具 20+ 且大部分低频使用时 |

### 方案 C：tools/list_changed 动态注册（协议原生）

**实现方式**:

1. 首屏 ListTools 只返回核心工具 + `enable_tools` 元工具
2. Agent 调用 `enable_tools("team")` → server 把 team 类工具加入内部注册表 → 发 `notifications/tools/list_changed`
3. Claude Code 收到通知 → 重新调用 `tools/list` → 拿到新工具 → 可直接调用

```ts
// 工具分组
const TOOL_GROUPS: Record<string, ToolSchema[]> = {
  core: [activateSchema, deactivateSchema, sendMsgSchema, checkInboxSchema, lookupSchema],
  team: [createTeamSchema, deleteTeamSchema, assignTaskSchema, ...],
  project: [createProjectSchema, listProjectsSchema, ...],
  mcp_store: [installMcpSchema, uninstallMcpSchema, ...],
};

// 运行时激活状态
const activeGroups = new Set(['core']);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    enableToolsSchema,
    ...Array.from(activeGroups).flatMap(g => TOOL_GROUPS[g] ?? [])
  ]
}));

// enable_tools handler
case 'enable_tools': {
  const group = args.group as string;
  if (!TOOL_GROUPS[group]) return toTextResult({ error: `unknown group: ${group}` });
  activeGroups.add(group);
  await server.sendToolListChanged();
  return toTextResult({
    enabled: group,
    tools: TOOL_GROUPS[group].map(t => t.name),
    note: 'Tools are now available. Call them directly.'
  });
}
```

| 维度 | 评价 |
|------|------|
| 优势 | **完整的协议原生方案**——新工具在 ListTools 中正式注册，agent 可直接调用；首屏 token 低；支持按需加载 |
| 劣势 | 依赖 Claude Code 正确处理 `tools/list_changed`（已验证支持）；每次 enable 需要一个额外的 list_changed → re-list 往返；每个 mteam stdio 进程各自维护状态（进程级隔离，不是问题） |
| 改动量 | ~100 行（工具分组注册表 + enable_tools 元工具 + server 声明 listChanged capability） |
| 需要客户端配合 | 需要客户端支持 `notifications/tools/list_changed`（Claude Code 2.1+ 已支持） |
| 适用场景 | 工具 15+ 且有明确分组时 |

### 方案 D：利用 Claude Code 原生 ToolSearch（Deferred Tools）

**实现方式**:

不在 MCP server 层做任何懒加载。利用 Claude Code 已有的 deferred tool loading 机制：

1. MCP server 正常注册所有工具（全量）
2. Claude Code 在连接时自动将超出阈值的工具标记为 deferred
3. Deferred tools 在 system-reminder 中只显示名字，不加载 schema
4. Agent 需要时通过内置 `ToolSearch` 按名字/关键词搜索加载 schema

**这就是当前会话中 mnemo 工具的工作方式**——mnemo 的 search、create_knowledge 等被列为 deferred tools，直到 ToolSearch 加载才可用。

| 维度 | 评价 |
|------|------|
| 优势 | **零改动**——mteam server 什么都不用改，全量注册所有工具；Claude Code 自动处理懒加载；agent 体验一致 |
| 劣势 | **黑箱依赖**——deferred 阈值、排序逻辑、哪些工具被 defer 全由 Claude Code 决定，mteam 无法控制；不解决角色分层（leader/member 看到相同工具）；需要工具数量足够多才触发 defer（少量工具不会被 defer） |
| 改动量 | 0 行 |
| 需要客户端配合 | 完全依赖客户端（Claude Code 特有功能，非 MCP 标准） |
| 适用场景 | 不需要角色分层、且信任 Claude Code 的默认策略时 |

### 方案 E：方案 A + C 组合（推荐）

**实现方式**:

分两层：
1. **角色过滤**（方案 A）：按 IS_LEADER 环境变量过滤工具可见性
2. **按需加载**（方案 C）：非核心工具通过 `enable_tools` 动态注册

```
首屏（leader）: activate, deactivate, send_msg, check_inbox, lookup, enable_tools
首屏（member）: activate, deactivate, send_msg, check_inbox, lookup

leader 调 enable_tools("team") → +create_team, +delete_team, +assign_task, ...
leader 调 enable_tools("project") → +create_project, +list_projects, ...
```

| 维度 | 评价 |
|------|------|
| 优势 | 同时解决角色分层和首屏 token 两个问题；member 看不到 enable_tools，根本无法触发管理类工具；扩展性好——新增工具组只需注册到 TOOL_GROUPS |
| 劣势 | 改动量稍大；enable_tools 依赖 tools/list_changed |
| 改动量 | ~120 行 |
| 需要客户端配合 | 需要 tools/list_changed 支持（已确认） |

---

## 三、方案对比矩阵

| | A 角色过滤 | B search_tools | C 动态注册 | D Claude ToolSearch | E 组合 |
|---|---|---|---|---|---|
| 解决角色分层 | **是** | 否 | 部分（需手动 enable） | **否** | **是** |
| 解决首屏 token | 否 | **是** | **是** | **是**（被动） | **是** |
| Agent 可直接调用新工具 | N/A | **否** | **是** | **是** | **是** |
| 改动量 | ~20 行 | ~80 行 | ~100 行 | 0 | ~120 行 |
| 客户端依赖 | 无 | 无/有 | list_changed | Claude 特有 | list_changed |
| 扩展性 | 一般 | 好 | **好** | 好 | **好** |

---

## 四、推荐方案

**推荐方案 E（A + C 组合）**，理由：

1. **唯一同时解决两个核心需求的方案** — 角色分层 + 首屏 token 控制
2. **协议原生** — 基于 MCP spec 的 `tools/list_changed` 标准能力，不依赖 Claude Code 特有行为
3. **已验证可行** — Claude Code 2.1+ 已支持 `list_changed` 通知，SDK 1.29 提供完整的 `sendToolListChanged()` API
4. **进程级隔离天然正确** — 每个成员 spawn 一个独立的 mteam stdio 进程，`IS_LEADER` env 和 activeGroups 都是进程私有状态，无并发冲突
5. **增量实施** — 先实现方案 A（角色过滤），15 分钟内完成；再叠加方案 C（动态注册），可独立开发测试

### 实施路径

**Phase 1（30 分钟）**: 方案 A 角色过滤
- `config.ts`: `readEnv()` 新增 `isLeader` 字段，读 `IS_LEADER` env
- `server.ts`: ListTools handler 按 `env.isLeader` 过滤
- 工具分为 core / leader_only / member_only 三类

**Phase 2（1 小时）**: 方案 C 动态注册
- 新建 `tools/enable_tools.ts` 和 `tools/registry.ts`（工具分组注册表）
- `server.ts`: capabilities 声明 `tools: { listChanged: true }`
- `server.ts`: enable_tools handler 修改 activeGroups 后调 `server.sendToolListChanged()`
- `enable_tools` 只在 leader 的工具集中出现

**Phase 3（后续）**: 与 MCP Store 集成
- 第三方 MCP 工具可以作为一个动态组注册
- `enable_tools("custom:mnemo")` → 启用 mnemo 的工具子集

---

## 五、关键实现细节

### 5.1 声明 listChanged capability

当前代码:
```ts
const server = new Server(
  { name: 'mteam', version: '0.1.0' },
  { capabilities: { tools: {} } },
);
```

需改为:
```ts
const server = new Server(
  { name: 'mteam', version: '0.1.0' },
  { capabilities: { tools: { listChanged: true } } },
);
```

### 5.2 sendToolListChanged 时机

`sendToolListChanged()` 必须在 transport 连接后调用（即 `server.connect()` 之后）。在 `enable_tools` 的 handler 中调用是安全的，因为 handler 只有在连接建立后才会被触发。

### 5.3 tools/call 对未注册工具的处理

MCP spec 要求：client 只能调用 ListTools 中返回的工具。如果 agent 尝试调用未 enable 的工具，server 应返回 protocol error `Unknown tool`。当前 server.ts 的 default case 已经处理了这种情况。

### 5.4 enable_tools 的幂等性

多次 `enable_tools("team")` 不应报错，Set 天然幂等。也可以增加 `disable_tools` 用于卸载（首期不需要）。

---

## 六、调研来源

| 来源 | 内容 |
|------|------|
| SDK 源码 `server/index.js` | Server 类、sendToolListChanged()、capabilities 校验 |
| SDK 源码 `server/mcp.js` | McpServer 高级 API、tool enable/disable、listChanged 自动通知 |
| SDK 源码 `client/index.js` | Client 如何处理 tools/list_changed 通知 |
| SDK 源码 `types.js` | ListToolsRequestSchema 分页支持、capabilities schema |
| MCP Spec `tools` 页面 | tools/list 分页、list_changed 通知、工具定义格式 |
| MCP Spec `pagination` 页面 | cursor-based 分页机制 |
| GitHub Issues #1300 | SEP: Tool Filtering with Groups and Tags（被拒） |
| GitHub Issues #2376 | RFC: lazyRegistration（已关闭） |
| Claude Code changelog | 确认支持 list_changed 通知、deferred tools / ToolSearch 机制 |
| 项目代码 `pty/manager.ts` | IS_LEADER env 已传入 mteam 进程 |
| 项目代码 `mcp/server.ts` | 当前 ListTools 实现 |
