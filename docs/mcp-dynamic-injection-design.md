# MCP 动态注入机制 — 技术方案

> 三层分离：MCP Store / 角色模板 / MCP 管理器

---

## 1. 现状分析

### 当前拼接链路

`instance.created` 事件 → `pty.subscriber` → `ptyManager.spawn(opts)` → 内联拼 `--mcp-config`。

`manager.ts` 第 77-103 行做了三件事：

1. 从 `opts.availableMcps`（string[]，来自模板）遍历名字
2. 对每个名字调 `findMcp(name)` 读 `~/.claude/team-hub/mcp-store/{name}.json`
3. store 里不存在 → stderr warn + skip；`__builtin__` → 内置 mteam MCP 入口；否则 → 原样取 command/args/env

写临时 JSON → `--mcp-config` 传给 CLI。

### 问题

| # | 问题 | 影响 |
|---|------|------|
| 1 | `availableMcps: string[]` 只记"要哪些 MCP"，没有工具可见性 | 无法做首屏/次屏分层 |
| 2 | 拼接逻辑散落在 `manager.ts`，与 PTY spawn 强耦合 | 不可测试、不可复用 |
| 3 | spawn 时才查 store，不订阅 store 变更 | 模板引用了已卸载 MCP 只在 spawn 时 warn，无前置感知 |
| 4 | mteam MCP server 的 `ListTools` 静态返回全部 6 个工具 | leader/member 看到一样的工具列表，不区分权限 |
| 5 | 没有 `searchTools` 元工具 | 工具数量增长后首屏膨胀 |

---

## 2. 三层架构设计

```
┌─────────────┐     ┌──────────────┐     ┌───────────────────┐
│  MCP Store   │     │  角色模板      │     │  MCP 管理器         │
│ (全局仓库)    │     │ (模板配置)     │     │ (快照 + resolve)   │
│              │     │              │     │                   │
│ command      │     │ mcpConfig[]  ├────►│ resolve(template) │
│ args/env     │     │ surface/search│    │ → McpConfigJSON   │
│ transport    │     │              │     │                   │
│ builtin      │     │ 不关心运行配置  │     │ 内存快照(Map)      │
└──────┬───────┘     └──────────────┘     └────────▲──────────┘
       │                                           │
       │      bus: mcp.installed / uninstalled      │
       └───────────────────────────────────────────┘
              管理器订阅事件维护快照，不主动查 store
```

### 职责边界

| 层 | 管什么 | 不管什么 |
|----|--------|----------|
| MCP Store | 全局 MCP server 运行配置 (command/args/env/transport)；安装/卸载/查询 | 角色模板、工具可见性 |
| 角色模板 | "我要哪些 MCP" + 每个 MCP 的工具可见性配置 (surface/search) | MCP Store、运行配置 |
| MCP 管理器 | 订阅 store 事件维护内存快照；resolve 时模板清单 ∩ 快照 → 输出可注入的完整 JSON | 不查 store、不做业务判断、不做 CRUD |

---

## 3. MCP Store 改动

**不需要改**。现有 store 已满足"全局仓库"职责：

- `listAll()` / `findByName()` / `install()` / `uninstall()` — 保留
- `McpConfig` 类型 — 保留
- 文件存储 `~/.claude/team-hub/mcp-store/` — 保留
- bus 事件 `mcp.installed` / `mcp.uninstalled` — 已存在

MCP 管理器通过订阅 bus 事件维护自己的快照，不需要 store 加任何新方法。

---

## 4. 角色模板 MCP 配置数据结构

### 现状

```ts
availableMcps: string[]  // ["mteam", "mnemo"]
```

### 升级为

```ts
// domain/role-template.ts 新增类型

/** 单个 MCP 的工具可见性配置 */
export interface McpToolVisibility {
  /** MCP 在 store 中的 name */
  name: string;
  /**
   * 首屏可见工具名。ListTools 直接返回这些。
   * 空数组 = 该 MCP 所有工具全部首屏可见（向后兼容默认行为）。
   * '*' 也表示全部可见。
   */
  surface: string[] | '*';
  /**
   * 通过 searchTools 元工具可搜索到的工具名。
   * 空数组 = 没有次屏工具。
   * '*' = 该 MCP 下除 surface 以外的全部工具。
   */
  search: string[] | '*';
}

/** 模板的 MCP 配置（替代旧的 string[]） */
export type TemplateMcpConfig = McpToolVisibility[];
```

### DB 兼容

`available_mcps` 列保持 `TEXT NOT NULL DEFAULT '[]'`。存 JSON，结构升级：

**旧格式**（string[]）：
```json
["mteam", "mnemo"]
```

**新格式**（McpToolVisibility[]）：
```json
[
  { "name": "mteam", "surface": ["activate", "send_msg", "check_inbox"], "search": "*" },
  { "name": "mnemo", "surface": "*", "search": [] }
]
```

### 向后兼容解析

`RoleTemplate.fromRow()` 需兼容两种格式：

```ts
private static parseMcpConfig(raw: string): TemplateMcpConfig {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item: unknown) => {
    // 旧格式：纯字符串 → 升级为全部首屏可见
    if (typeof item === 'string') {
      return { name: item, surface: '*' as const, search: [] };
    }
    // 新格式：对象
    const obj = item as Record<string, unknown>;
    return {
      name: obj.name as string,
      surface: (obj.surface ?? '*') as string[] | '*',
      search: (obj.search ?? []) as string[] | '*',
    };
  });
}
```

### 类型变更

```ts
// RoleTemplateProps
-  availableMcps: string[];
+  availableMcps: TemplateMcpConfig;

// CreateRoleTemplateInput
-  availableMcps?: string[];
+  availableMcps?: TemplateMcpConfig;

// UpdateRoleTemplateInput
-  availableMcps?: string[];
+  availableMcps?: TemplateMcpConfig;
```

API 层序列化/反序列化不变（JSON 列，直接存对象数组）。前端如有改动只是渲染层调整。

---

## 5. MCP 管理器设计

### 位置

新文件：`packages/backend/src/mcp-store/mcp-manager.ts`

### 输出格式

```ts
/** 可直接写入 --mcp-config 临时文件的 JSON 结构 */
export interface McpConfigJson {
  mcpServers: Record<string, {
    command: string;
    args: string[];
    env: Record<string, string>;
  }>;
}

/** resolve 的完整结果，包含可见性信息供 mteam MCP server 使用 */
export interface ResolvedMcpSet {
  /** 写入 --mcp-config 的 JSON */
  configJson: McpConfigJson;
  /**
   * 每个 MCP 的工具可见性配置（key = mcp name）。
   * mteam MCP server 通过 env 接收这份配置，控制 ListTools 输出。
   */
  visibility: Record<string, { surface: string[] | '*'; search: string[] | '*' }>;
  /** store 中不存在而被跳过的 MCP 名（用于日志/告警） */
  skipped: string[];
}
```

### 核心类

```ts
import { Subscription } from 'rxjs';
import type { TemplateMcpConfig } from '../domain/role-template.js';
import type { McpConfig } from './types.js';
import { listAll } from './store.js';
import { bus } from '../bus/index.js';

export interface McpManagerContext {
  /** 角色实例 ID，用于 __builtin__ 的 env 注入 */
  instanceId: string;
  /** hub HTTP URL */
  hubUrl: string;
  /** comm socket 路径 */
  commSock: string;
  /** 是否 leader */
  isLeader: boolean;
}

/**
 * MCP 管理器 — 订阅 store 事件维护快照，resolve 时从内存取交集。
 *
 * 生命周期：server 启动时 boot()，关闭时 teardown()。
 * resolve() 保证：输出的 configJson 里每个 MCP 一定是当前可用的。
 */
export class McpManager {
  private snapshot = new Map<string, McpConfig>();
  private sub: Subscription | null = null;

  /** 启动：从 store 拿一次全量，然后订阅增量事件 */
  boot(): void {
    for (const cfg of listAll()) {
      this.snapshot.set(cfg.name, cfg);
    }
    this.sub = new Subscription();
    this.sub.add(
      bus.on('mcp.installed').subscribe((e) => {
        // 新安装的 MCP，从 store 读最新配置加入快照
        const cfg = findByName(e.mcpName);
        if (cfg) this.snapshot.set(cfg.name, cfg);
      }),
    );
    this.sub.add(
      bus.on('mcp.uninstalled').subscribe((e) => {
        this.snapshot.delete(e.mcpName);
      }),
    );
  }

  teardown(): void {
    this.sub?.unsubscribe();
    this.sub = null;
    this.snapshot.clear();
  }

  /** 快照里是否有这个 MCP */
  isAvailable(name: string): boolean {
    return this.snapshot.has(name);
  }

  /** 标注模板中哪些 MCP 当前不可用 */
  checkTemplate(mcps: TemplateMcpConfig): { name: string; available: boolean }[] {
    return mcps.map((m) => ({ name: m.name, available: this.snapshot.has(m.name) }));
  }

  /**
   * resolve: 模板清单 ∩ 内存快照 → 完整可注入配置。
   * 快照里没有的自动跳过，记入 skipped。
   */
  resolve(templateMcps: TemplateMcpConfig, ctx: McpManagerContext): ResolvedMcpSet {

  const mcpServers: McpConfigJson['mcpServers'] = {};
  const visibility: ResolvedMcpSet['visibility'] = {};
  const skipped: string[] = [];

  for (const mcpDef of templateMcps) {
    const storeCfg = this.snapshot.get(mcpDef.name);
    if (!storeCfg) {
      skipped.push(mcpDef.name);
      continue;
    }

    // 运行配置
    if (storeCfg.command === '__builtin__') {
      mcpServers[mcpDef.name] = {
        command: process.execPath,
        args: [getMteamMcpEntry()],
        env: {
          ROLE_INSTANCE_ID: ctx.instanceId,
          V2_SERVER_URL: ctx.hubUrl,
          TEAM_HUB_COMM_SOCK: ctx.commSock,
          IS_LEADER: ctx.isLeader ? '1' : '0',
          // 工具可见性配置（序列化为 JSON 字符串传入子进程）
          MTEAM_TOOL_VISIBILITY: JSON.stringify({
            surface: mcpDef.surface,
            search: mcpDef.search,
          }),
        },
      };
    } else {
      mcpServers[mcpDef.name] = {
        command: storeCfg.command,
        args: storeCfg.args,
        env: storeCfg.env,
      };
    }

    visibility[mcpDef.name] = {
      surface: mcpDef.surface,
      search: mcpDef.search,
    };
  }

  if (skipped.length > 0) {
    process.stderr.write(
      `[mcp-manager] skipped (not in store): ${skipped.join(', ')}\n`,
    );
  }

  return { configJson: { mcpServers }, visibility, skipped };
}

/** mteam MCP 入口路径 */
function getMteamMcpEntry(): string {
  // 相对于编译产物的路径，与现有 manager.ts 一致
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'index.js');
}
```

### 与 store 的联动

McpManager 通过 bus 订阅 `mcp.installed` / `mcp.uninstalled` 维护内存快照。
- boot() 时从 store 拿一次全量初始化
- 之后增量靠事件，不再查 store
- resolve() 读内存快照取交集，零 I/O
- isAvailable() / checkTemplate() 也读内存，供 API 层和前端使用

---

## 6. searchTools 元工具机制

### 概述

mteam MCP server 内部实现工具分层：首屏工具（surface）直接在 `ListTools` 返回，次屏工具（search）通过 `search_tools` 元工具按需注册。

### 环境变量读取

mteam MCP 子进程从 env 读取可见性配置：

```ts
// mcp/config.ts — 扩展 readEnv

export interface MteamEnv {
  instanceId: string;
  hubUrl: string;
  commSock: string;
  isLeader: boolean;
  toolVisibility: {
    surface: string[] | '*';
    search: string[] | '*';
  };
}

export function readEnv(): MteamEnv {
  // ...existing...
  const isLeader = process.env.IS_LEADER === '1';
  const toolVisibility = process.env.MTEAM_TOOL_VISIBILITY
    ? JSON.parse(process.env.MTEAM_TOOL_VISIBILITY)
    : { surface: '*', search: [] };
  return { instanceId, hubUrl, commSock, isLeader, toolVisibility };
}
```

### 工具注册表

所有 mteam 工具注册到一个 registry，每个工具声明自己的角色约束：

```ts
// mcp/tools/registry.ts — 新文件

export interface ToolEntry {
  schema: { name: string; description: string; inputSchema: object };
  handler: (env: MteamEnv, args: Record<string, unknown>, deps: ToolDeps) => Promise<unknown>;
  /** 约束：仅 leader 可用 */
  leaderOnly: boolean;
}

/** 全量工具注册表 */
const ALL_TOOLS: ToolEntry[] = [
  { schema: activateSchema,       handler: (env) => runActivate(env),           leaderOnly: false },
  { schema: deactivateSchema,     handler: (env) => runDeactivate(env),         leaderOnly: false },
  { schema: requestOfflineSchema, handler: (env, args) => runRequestOffline(env, args), leaderOnly: true },
  { schema: sendMsgSchema,        handler: (env, _, deps) => runSendMsg(env, deps.comm, _), leaderOnly: false },
  { schema: checkInboxSchema,     handler: (env, args) => runCheckInbox(env, args),     leaderOnly: false },
  { schema: lookupSchema,         handler: (env, args) => runLookup(env, args),         leaderOnly: false },
  // ...future tools...
];
```

### ListTools 分层逻辑

```ts
// mcp/server.ts — 重构 ListToolsRequestSchema handler

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = resolveVisibleTools(env, ALL_TOOLS);
  // search_tools 元工具本身始终在首屏（如果有次屏工具的话）
  if (hasSearchableTools(env, ALL_TOOLS)) {
    tools.push(searchToolsSchema);
  }
  return { tools };
});
```

```ts
// mcp/tools/visibility.ts — 新文件

/**
 * 根据 env.toolVisibility.surface + env.isLeader 过滤首屏工具。
 *
 * 逻辑：
 * 1. 从 ALL_TOOLS 中过滤出当前角色可用的工具（leaderOnly 检查）
 * 2. 再从中筛出 surface 配置命中的工具
 *    - surface === '*' → 全部可用工具都在首屏
 *    - surface === string[] → 只返回名字在列表中的
 */
export function resolveVisibleTools(
  env: MteamEnv,
  registry: ToolEntry[],
): ToolSchema[] {
  const roleFiltered = registry.filter(
    (t) => !t.leaderOnly || env.isLeader,
  );

  if (env.toolVisibility.surface === '*') {
    return roleFiltered.map((t) => t.schema);
  }

  const surfaceSet = new Set(env.toolVisibility.surface);
  return roleFiltered
    .filter((t) => surfaceSet.has(t.schema.name))
    .map((t) => t.schema);
}

/**
 * 判断是否存在可搜索但不在首屏的工具。
 * 有 → 需要注册 search_tools 元工具；无 → 不注册。
 */
export function hasSearchableTools(
  env: MteamEnv,
  registry: ToolEntry[],
): boolean {
  const roleFiltered = registry.filter(
    (t) => !t.leaderOnly || env.isLeader,
  );
  if (env.toolVisibility.search === '*') {
    // '*' 意味着除 surface 以外的都可搜
    const surfaceCount = env.toolVisibility.surface === '*'
      ? roleFiltered.length
      : (env.toolVisibility.surface as string[]).length;
    return roleFiltered.length > surfaceCount;
  }
  return (env.toolVisibility.search as string[]).length > 0;
}
```

### search_tools 元工具

```ts
// mcp/tools/search_tools.ts — 新文件

export const searchToolsSchema = {
  name: 'search_tools',
  description:
    'Search for additional tools not shown in the default list. ' +
    'Returns matching tool names and descriptions. ' +
    'After finding what you need, the tool will be dynamically registered.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Keyword to search tool names and descriptions',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

/**
 * 搜索次屏工具。匹配后通过 server.sendToolListChanged() 动态注册到 CLI。
 *
 * 流程：
 * 1. 在 registry 中搜索 query 匹配的次屏工具（name/description 模糊匹配）
 * 2. 将匹配到的工具加入 activeSurface Set（内存状态）
 * 3. 调 server.sendToolListChanged() 通知 CLI 刷新 tools/list
 * 4. 下次 ListTools 时这些工具就在首屏了
 * 5. 返回匹配结果给 agent
 */
export function runSearchTools(
  env: MteamEnv,
  registry: ToolEntry[],
  activeSurface: Set<string>,
  args: Record<string, unknown>,
  notifyChanged: () => void,
): { results: { name: string; description: string }[]; activated: string[] } {
  const query = ((args.query as string) ?? '').toLowerCase();

  // 收集当前角色可用但不在首屏的工具
  const searchable = resolveSearchableTools(env, registry);

  // 模糊匹配
  const matched = searchable.filter(
    (t) =>
      t.schema.name.toLowerCase().includes(query) ||
      t.schema.description.toLowerCase().includes(query),
  );

  const activated: string[] = [];
  for (const t of matched) {
    if (!activeSurface.has(t.schema.name)) {
      activeSurface.add(t.schema.name);
      activated.push(t.schema.name);
    }
  }

  // 有新工具被激活 → 通知 CLI 刷新
  if (activated.length > 0) {
    notifyChanged();
  }

  return {
    results: matched.map((t) => ({
      name: t.schema.name,
      description: t.schema.description,
    })),
    activated,
  };
}
```

### server.ts 整合

```ts
// mcp/server.ts — 重构版骨架

export async function runMteamServer(): Promise<void> {
  const env = readEnv();
  const comm = new CommClient(env.commSock, `local:${env.instanceId}`);

  // 动态激活的工具（search_tools 激活后加入此 set）
  const activeSurface = new Set<string>();

  const server = new Server(
    { name: 'mteam', version: '0.2.0' },
    { capabilities: { tools: { listChanged: true } } },  // 声明支持 listChanged
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = resolveVisibleTools(env, ALL_TOOLS, activeSurface);
    if (hasSearchableTools(env, ALL_TOOLS, activeSurface)) {
      tools.push(searchToolsSchema);
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (name === 'search_tools') {
      return toTextResult(
        runSearchTools(env, ALL_TOOLS, activeSurface, args, () => {
          server.notification({ method: 'notifications/tools/list_changed' });
        }),
      );
    }

    // 在 registry 中查找（含首屏 + 已激活的次屏）
    const entry = ALL_TOOLS.find((t) => t.schema.name === name);
    if (!entry) return toTextResult({ error: `unknown tool: ${name}` });

    // 角色检查
    if (entry.leaderOnly && !env.isLeader) {
      return toTextResult({ error: `tool '${name}' is leader-only` });
    }

    try {
      return toTextResult(await entry.handler(env, args, { comm }));
    } catch (e) {
      return toTextResult({ error: (e as Error).message });
    }
  });

  // ...transport + cleanup (same as before)
}
```

### resolveVisibleTools 增强版（支持 activeSurface）

```ts
export function resolveVisibleTools(
  env: MteamEnv,
  registry: ToolEntry[],
  activeSurface?: Set<string>,
): ToolSchema[] {
  const roleFiltered = registry.filter(
    (t) => !t.leaderOnly || env.isLeader,
  );

  let visible: ToolEntry[];
  if (env.toolVisibility.surface === '*') {
    visible = roleFiltered;
  } else {
    const surfaceSet = new Set(env.toolVisibility.surface);
    visible = roleFiltered.filter((t) => surfaceSet.has(t.schema.name));
  }

  // 追加 search_tools 动态激活的工具
  if (activeSurface && activeSurface.size > 0) {
    const extra = roleFiltered.filter(
      (t) => activeSurface.has(t.schema.name) && !visible.includes(t),
    );
    visible = [...visible, ...extra];
  }

  return visible.map((t) => t.schema);
}
```

---

## 7. 角色过滤机制

### IS_LEADER env

`IS_LEADER` 通过 MCP 管理器 `resolve()` 注入 `__builtin__` MCP 子进程的 env。

```
spawn → resolve(templateMcps, ctx) → ctx.isLeader → env.IS_LEADER
```

### 双重过滤

1. **角色过滤**（`leaderOnly` 字段）：不管模板怎么配，member 永远看不到 leader-only 工具。这是硬约束。
2. **可见性过滤**（`surface/search` 配置）：在角色过滤之后，再按模板配置决定哪些在首屏、哪些在次屏。这是软配置。

```
所有工具
  → 角色过滤（leader-only 检查，硬约束）
    → 可见性过滤（surface/search 配置，软配置）
      → 首屏工具（ListTools 返回）
```

### 效果示例

leader 模板配置：
```json
{ "name": "mteam", "surface": ["activate", "send_msg", "create_team"], "search": "*" }
```

member 模板配置：
```json
{ "name": "mteam", "surface": ["activate", "send_msg", "check_inbox"], "search": ["lookup"] }
```

leader 首屏看到：activate, send_msg, create_team, search_tools
member 首屏看到：activate, send_msg, check_inbox, search_tools

member 搜索时只能搜到 lookup，搜不到 request_offline（被 leaderOnly 硬过滤掉了）。

---

## 8. 联动链路

### store 安装新 MCP

```
POST /api/mcp-store/install
  → store.install(config)
  → bus.emit('mcp.installed', { mcpName })
  → McpAvailabilityChecker 更新 available Set
  → 前端 WS 收到事件，刷新 MCP Store 列表
  → 模板编辑界面可选的 MCP 列表自动多了一项
  → 新 spawn 的实例：resolve() 读 store 能找到 → 注入成功
  → 已运行的实例：不受影响（MCP 子进程已在内存）
```

### store 卸载 MCP

```
DELETE /api/mcp-store/:name
  → store.uninstall(name)
  → bus.emit('mcp.uninstalled', { mcpName })
  → McpAvailabilityChecker 更新 available Set
  → 前端 WS 收到事件，刷新 MCP Store 列表
  → GET /api/role-templates 返回时可附带可用性标注（optional enhancement）
  → 新 spawn 的实例：resolve() 读 store 找不到 → 自动跳过，记入 skipped
  → 已运行的实例：不受影响
```

### 关键决策：卸载不清理模板

模板的 `availableMcps` 里引用了已卸载 MCP 时：
- **不自动删除**引用（避免"装回来还得重配"）
- resolve 时自动跳过 + stderr warn
- API 可选择在返回模板时附带 `mcpAvailability` 字段标注可用性

---

## 9. spawn 时的安全保证

### 保证 1：输出的一定可用

`resolve()` 从 store **同步读文件**。读不到 → 跳过。输出的 `configJson.mcpServers` 中每个 MCP 都有完整的 command/args/env，CLI 拿到就能 spawn。

### 保证 2：不会因卸载崩溃

`resolve()` 是 **spawn 前** 调用的。store 卸载发生在另一个 API handler 中，不会与 resolve 产生竞态（bun 单线程 + 同步文件 IO）。

### 保证 3：临时文件生命周期

```
spawn 前：resolve() → writeFileSync(tmpPath, configJson)
spawn 后：CLI 读取 --mcp-config → 子进程启动
退出时  ：cleanup() → unlinkSync(tmpPath)
```

这个流程不变，只是 resolve 逻辑从 manager.ts 内联移到了 mcp-manager.ts。

### 保证 4：__builtin__ MCP 永远可用

mteam 在 store 中标记 `builtin: true`，不可卸载（uninstall 检查 builtin 字段 → 抛错）。resolve 一定能找到它。

---

## 10. 改动文件清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/mcp-store/mcp-manager.ts` | MCP 管理器：resolve() + McpAvailabilityChecker |
| `src/mcp/tools/registry.ts` | 工具注册表：ALL_TOOLS + ToolEntry 类型 |
| `src/mcp/tools/visibility.ts` | 可见性计算：resolveVisibleTools + hasSearchableTools + resolveSearchableTools |
| `src/mcp/tools/search_tools.ts` | search_tools 元工具 |
| `src/mcp-store/__tests__/mcp-manager.test.ts` | 管理器单测 |
| `src/mcp/tools/__tests__/visibility.test.ts` | 可见性逻辑单测 |
| `src/mcp/tools/__tests__/search_tools.test.ts` | search_tools 单测 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/mcp-store/store.ts` | 新增 `findByNames()` |
| `src/mcp-store/types.ts` | 无改动（McpConfig 类型不变） |
| `src/domain/role-template.ts` | `availableMcps` 类型从 `string[]` 改为 `TemplateMcpConfig`；新增 `McpToolVisibility` 类型；fromRow 加兼容解析 |
| `src/mcp/config.ts` | `MteamEnv` 新增 `isLeader` + `toolVisibility`；readEnv 解析新 env |
| `src/mcp/server.ts` | 用 registry + visibility 重构 ListTools/CallTool；声明 `listChanged` capability；集成 search_tools |
| `src/pty/manager.ts` | spawn 中的 MCP 拼接逻辑替换为调 `resolve()`；传 `IS_LEADER` 和 `MTEAM_TOOL_VISIBILITY` env |
| `src/bus/subscribers/pty.subscriber.ts` | 传 `isLeader` 给 spawn opts（从 InstanceCreatedEvent 取） |
| `src/bus/index.ts` | `bootSubscribers` 中初始化 McpAvailabilityChecker（可选） |

### 不改的文件

| 文件 | 原因 |
|------|------|
| `src/bus/types.ts` | mcp.installed/uninstalled 事件已存在，无需改 |
| `src/api/panel/mcp-store.ts` | store CRUD + emit 不变 |
| `src/db/schemas/role_templates.sql` | available_mcps 列类型不变（TEXT，JSON 格式升级但列定义不变） |

---

## 11. 实施计划

### Phase 1：MCP 管理器 + 模板升级（核心）

1. `role-template.ts` 类型升级 + 兼容解析
2. `mcp-manager.ts` 实现 resolve()
3. `manager.ts` 重构：内联拼接 → 调 resolve()
4. `pty.subscriber.ts` 传 isLeader
5. 单测覆盖 resolve / 兼容解析 / skipeed

预期：**现有行为不变**（旧格式 string[] 自动升级为 surface='*'），新功能就绪。

### Phase 2：工具注册表 + 可见性

1. `tools/registry.ts` 全量工具注册
2. `tools/visibility.ts` 分层计算
3. `config.ts` 读 IS_LEADER + MTEAM_TOOL_VISIBILITY
4. `server.ts` 重构 ListTools / CallTool
5. 单测覆盖 visibility 各 case

预期：leader/member 看到不同工具列表。

### Phase 3：search_tools 元工具

1. `tools/search_tools.ts` 实现
2. `server.ts` 集成 search_tools + listChanged notification
3. 单测 + 集成测试

预期：agent 可搜索次屏工具，搜到后自动注册到首屏。

### Phase 4：McpAvailabilityChecker（可选增强）

1. 实现 checker + 接入 bus
2. API 返回模板时附带可用性标注
3. 前端展示不可用 MCP 的警告

预期：前端编辑模板时实时感知 MCP 可用性。
