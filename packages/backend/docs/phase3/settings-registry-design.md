# Phase Settings Registry —— 统一设置注册表 + Settings MCP

> 日期：2026-04-27
> 状态：设计阶段（只有文档，不动代码）
> 范围：`packages/backend/src/settings/` 新建；`packages/backend/src/mcp-primary/tools/` 新增 3 工具；WS 协议加一条下行事件

---

## 0. 目标与非目标

**目标**

1. Agent（主要指主 Agent 与 Leader）可以像查字典一样搜索所有"可改配置"。
2. Agent 可直接修改设置（`update_setting`），也可以把设置面板弹给用户（`show_setting`，fire-and-forget）。
3. 用户通过 UI 改设置后，按需通过现有 comm 通道给相关 agent 发一条通知（不是所有设置都通知）。
4. **不改现有模块的内部实现**。所有读写通过 registry 薄封装转发到已存在的 DAO / HTTP handler。

**非目标**

- 不新建 `settings` 表，不搞"统一数据库 schema"（论证见 §2）。
- 不做权限模型（谁能改谁的设置）；当前单用户 local，全部视为"用户本人授权"。
- 不做设置版本迁移 / undo stack。
- CLI 列表作为只读条目列出，但本期不做"追加 CLI 白名单"这种会改模块逻辑的设置。

---

## 1. 现状分析

### 1.1 各模块的可配置项（调研结果）

| 模块 | 位置 | 可配置字段 | 读 | 写 | HTTP |
|------|------|-----------|----|----|------|
| **主 Agent** | `primary-agent/types.ts` `PrimaryAgentRow` | `name`, `cliType`, `systemPrompt`, `mcpConfig`, `sandbox`, `autoApprove` | `repo.readRow()` | `repo.upsertConfig(PrimaryAgentConfig)` | `POST /api/panel/primary-agent`；WS op `configure_primary_agent` |
| **角色模板** | `domain/role-template.ts` `RoleTemplate` | `role`, `description`, `persona`, `avatar`, `availableMcps`（每项含 `surface` / `search` 可见性） | `RoleTemplate.findByName` / `listAll` | `RoleTemplate.create` / `update` / `delete` | `/api/panel/templates/*`（= `/api/role-templates/*` forward） |
| **MCP Store** | `mcp-store/store.ts` | 每条 `McpConfig`：`name`, `displayName`, `description`, `command`, `args[]`, `env{}`, `transport`；内置 `mteam` 只读 | `listAll()` / `findByName` | `install()` / `uninstall()` | `/api/panel/mcp/store` (GET) —— **写入接口目前缺**，设计见 §7 延展 |
| **头像** | `avatar/repo.ts` | `addCustom(id, filename)` / `remove(id)` / `restoreBuiltins()`；builtin hidden 开关 | `listAll` / `listVisible` | `addCustom` / `remove` / `restoreBuiltins` | `/api/panel/avatars/*` |
| **通知** | `notification/notification-store.ts` | `NotificationConfig`：`mode: 'proxy_all'\|'direct'\|'custom'`，`rules: CustomRule[]` | `store.get(userId)` | `store.upsert(cfg)` | **未对外暴露 HTTP**（只在内部 subscriber 用） |
| **可见性** | `filter/filter-store.ts` | `VisibilityRule`：`principal`（user/agent/system）× `target`（user/agent/team/system）× `effect` | `list` / `listForPrincipal` | `upsert` / `remove` | **未对外暴露 HTTP** |
| **CLI 列表** | `cli-scanner/manager.ts` | `CliInfo[]`：`{name, available, path, version}` | `getAll()` / `getInfo()` / `refresh()` | 只读 | `/api/panel/cli/*` |

**观察**

- 每个模块都有干净的 DAO / manager，读写方法的签名都相对稳定。
- 大部分模块已经有 HTTP 接口（走 `/api/panel/*` 门面层）。缺口是 MCP Store 的写（install/uninstall）、通知配置、可见性规则 —— 但这些也已经是"某个 DAO 的薄封装即可暴露"，不需要重构。
- 所有模块都 emit 对应的 bus 事件（`template.updated` / `mcp.installed` / `primary_agent.configured` 等），通知机制天然可以搭在 bus 上。

### 1.2 主 Agent / Leader 当前改设置的路径

- 主 Agent 基本不改设置，因为它不是"会干活的 agent"，只能用 `mteam-primary` 的 4 个工具。
- Leader / 成员可以通过 MCP 改，但只有 `add_member` / `send_msg` 类**运行时动作**，没有"改模板 / 改 MCP Store / 改通知配置"这类**配置型动作**。
- 用户改设置现在只能靠前端 UI。Agent 如果想"帮用户把系统提示词改一下"是做不到的。

这正是本期要补的空。

---

## 2. 方案选型：A（薄 registry） vs B（统一 settings 表）

### 方案 A：不改现有模块，加一层 registry 薄封装

- 每个模块注册一组 `SettingEntry { key, label, description, schema, getter, setter, notify }`
- registry 维护数组；`search(q)` 就是内存 `filter`（entries 总量百级，不需要索引）
- `getter/setter` 调已存在的 repo / manager 方法，不动内部实现

### 方案 B：把所有设置收敛到单张 `settings(key TEXT PK, value JSON, schema JSON)` 表

- 现有 7 个模块全部改成读写这张表
- 好处：真正"一张表" + 事件循环一致 + 迁移统一
- 代价：
  - 现有每个 DAO 的 schema 约束（`NOT NULL` / FK / 类型列）全部丢失，只剩 JSON blob
  - `role_templates.avatar FK → avatars.id`、`notification_configs.user_id` 等关联全部要手工在应用层重建
  - 7 个模块 + 所有订阅测试 + 相关 HTTP 路由全部要改，风险面巨大
  - `RoleTemplate.listAll()` 这类"全量查询 + ORM 行为"要重写成 JSON scan
  - 没有任何短期收益，因为前端 / WS / bus 事件都已经围绕现有表设计

### 推荐：方案 A

理由：

1. **零侵入**：现有 13 个表 + 13 个 DAO 保持不变，bus 事件链、订阅器、HTTP 路由全部不动。
2. **收益足够**：Agent 的需求是"搜 + 读 + 写 + 弹面板 + 通知"，这些全部可以在 registry 层完成。
3. **扩展不锁死**：如果未来真的要统一 settings 表（比如做导入/导出/配置同步），只需要替换 `SettingEntry.getter/setter` 的内部实现，registry 外观不变。
4. **规模合理**：本期设置项约 25 条（见 §6），内存 filter + 手写 TF-IDF-lite 足以支撑"模糊搜索"。

---

## 3. 核心类型

```ts
// packages/backend/src/settings/types.ts

export type SettingCategory =
  | 'primary-agent'
  | 'templates'
  | 'avatars'
  | 'mcp-store'
  | 'notification'
  | 'visibility'
  | 'cli';

/** 设置变更后的通知策略。 */
export type NotifyPolicy =
  | 'none'                      // 不通知
  | 'primary'                   // 通过 comm 给主 Agent 发一条
  | { kind: 'related-agents';   // 关联 agent：用 resolver 决定要通知谁
      resolve: (newValue: unknown, oldValue: unknown) => string[]; };

/** JSON Schema 子集（拿来驱动前端表单渲染，不做运行时强校验）。 */
export interface SettingSchema {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array';
  enumValues?: ReadonlyArray<string>;
  items?: SettingSchema;         // array 用
  properties?: Record<string, SettingSchema>;  // object 用
  description?: string;
}

export interface SettingEntry<V = unknown> {
  key: string;                   // 形如 'primary-agent.systemPrompt'；全局唯一
  label: string;                 // 人话名称，前端直接显示
  description: string;           // 一句话说明，用于搜索命中 + tooltip
  category: SettingCategory;
  schema: SettingSchema;
  readonly: boolean;             // 只读条目（CLI 列表）；setter 调会抛 'readonly'
  notify: NotifyPolicy;
  getter: () => V;
  setter: (value: V) => void | Promise<void>;
  /** 搜索用辅助字段：tag、同义词。默认取 label+description 分词。 */
  keywords?: readonly string[];
}

export interface SearchResult {
  entries: SettingEntry[];       // 按相关度排序
  total: number;
}
```

**复合 key 约定**

- 单例配置：`primary-agent.systemPrompt`、`notification.mode`
- 列表型：`templates.<name>.role`、`mcp-store.<name>.env`、`avatars.<id>.hidden`
- 列表根键：`templates`（整张表，可做"新建模板"这种列表操作）

列表型的 `<name>` / `<id>` 是**运行时现查**（`RoleTemplate.listAll()` 遍历），registry 不持久化扩展 key，避免和 DAO 状态脱同步。

---

## 4. Registry 模块

```ts
// packages/backend/src/settings/registry.ts

class SettingsRegistry {
  private entries = new Map<string, SettingEntry>();

  register(entry: SettingEntry): void;
  get(key: string): SettingEntry | null;

  /** 物化所有条目（静态 + 动态列表型）。每次 search 都先调这里生成最新视图。 */
  materialize(): SettingEntry[];

  /** 模糊搜索：基于 label + description + keywords 的 token 命中打分。 */
  search(q: string, limit?: number): SearchResult;

  /** 读值：包装 getter + 统一异常。 */
  read(key: string): { key: string; value: unknown } | { error: string };

  /** 写值：setter + emit bus 事件 + 通知分发。 */
  async write(key: string, value: unknown, actor: { kind: 'user' | 'agent'; id: string }):
    Promise<{ ok: true } | { error: string }>;
}
```

**关键点**

- `materialize` 每次全量生成：静态条目直接拿，列表型调 `listAll` 枚举一次。百级数据没有性能问题。
- `search` 打分：
  1. q 按中英文分词（简单空格 + CJK 逐字符）
  2. 对每条 entry，合并 `label` + `description` + `keywords` + `key` 为文本，按 token 命中数加权（label 3x / description 1x / keywords 2x / key 精确匹配 5x）
  3. 返回 top N（默认 20）
- `write` 流程：
  1. `entry.readonly` → 立即 `{ error: 'readonly' }`
  2. 读 `oldValue = entry.getter()`（通知 resolver 要用）
  3. 调 `entry.setter(value)`，抛错收敛 `{ error }`
  4. 调 `notify.dispatch(entry, newValue, oldValue, actor)`（见 §5）
  5. 返回 `{ ok: true }`
- 不 emit 新的 bus 事件：现有模块的 DAO 已经 emit（`template.updated` / `primary_agent.configured` 等）。registry 不多发一轮避免重复。

---

## 5. 通知机制

```ts
// packages/backend/src/settings/notify.ts

export interface SettingsNotifyDeps {
  commRouter: CommRouter;
  getPrimaryAgentInstanceId: () => string | null;
  getActiveUserId: () => string | null;  // 单用户场景 'local'
}

export function dispatchNotify(
  entry: SettingEntry,
  newValue: unknown,
  oldValue: unknown,
  actor: { kind: 'user' | 'agent'; id: string },
  deps: SettingsNotifyDeps,
): void;
```

**分支**

- `notify === 'none'`：直接 return。
- `notify === 'primary'`：
  - 如果 `actor.kind === 'agent'` 且 `actor.id === primaryId` → return（别让主 Agent 通知自己）
  - 否则：构造 `system → primary_agent` envelope，内容 `用户修改了"{entry.label}"：{简短 diff}`，调 `commRouter.dispatch`
- `notify = { kind: 'related-agents', resolve }`：
  - `ids = resolve(newValue, oldValue)`（返回 `instanceId[]`）
  - 对每个 id 构造 `system → agent` envelope，调 `commRouter.dispatch`
  - resolve 抛错 / 返空数组都 fail-soft

**简短 diff 约定**

- primitive：`旧值: X → 新值: Y`（字符串 ≥ 80 字的截断为 `X... → Y...`）
- object / array：`{ changed_fields: [...] }`
- 让 agent 能从 notifyLine 直接判断是否需要处理，不必再去 read

**与现有通知链路的关系**

- 现有 `bus/subscribers/notification.subscriber.ts` 负责"bus 事件 → agent"的分发，本期复用它的 `commRouter.dispatch(system→agent)` 能力，**不走 proxyRouter**（proxyRouter 是按 `NotificationConfig.mode` 决定"推给用户 or 推给 primary"，对"设置变更"这种系统消息是反模式）。
- 直接用 `buildEnvelope({ from: system, to: {kind:'agent', instanceId}, content, summary })` → `commRouter.dispatch`。

---

## 6. 完整设置项清单

### 6.1 主 Agent（primary-agent）

| key | label | schema | readonly | notify | 说明 |
|-----|-------|--------|----------|--------|------|
| `primary-agent.name` | 主 Agent 名称 | string | false | primary | 改名会推一条通知 |
| `primary-agent.cliType` | CLI 类型 | enum(`claude`\|`codex`) | false | primary | 切 CLI 触发重启（现有 WS configure 行为） |
| `primary-agent.systemPrompt` | 系统提示词 | string (textarea) | false | primary | 主 Agent 自己改可能需要知道 |
| `primary-agent.mcpConfig` | MCP 配置 | array<McpToolVisibility> | false | primary | 改了 MCP 需要重启主 Agent |
| `primary-agent.sandbox` | 容器沙箱 | boolean | false | primary | — |
| `primary-agent.autoApprove` | 自动授权 | boolean | false | primary | — |

### 6.2 角色模板（templates）

> 列表型：每个模板展开成 5 个 key。`RoleTemplate.listAll()` 动态枚举。

| key | label | schema | readonly | notify | 说明 |
|-----|-------|--------|----------|--------|------|
| `templates` | 模板列表（根） | array<{name,role,...}> | false | related-agents（按 name resolve 到正在使用该模板的实例） | 整体只读视图，setter 不支持（新建走 HTTP）|
| `templates.<name>.role` | 角色 | string | false | related-agents | resolver：查 `role_instances WHERE templateName=<name>` 的 id[] |
| `templates.<name>.description` | 简介 | string | false | none | 描述性字段，不触发通知 |
| `templates.<name>.persona` | 人设 | string (textarea) | false | related-agents | 同上 |
| `templates.<name>.avatar` | 头像 | enum(avatar ids) | false | none | 仅 UI 显示 |
| `templates.<name>.availableMcps` | 可用 MCP | array<McpToolVisibility> | false | related-agents | resolver 同 role |

> `related-agents` 的 resolver 统一放在 `entries/templates.ts`，避免每条 key 重写。

### 6.3 头像（avatars）

| key | label | schema | readonly | notify | 说明 |
|-----|-------|--------|----------|--------|------|
| `avatars` | 头像列表（根） | array<AvatarRow> | false | none | setter 不支持（增删走 HTTP） |
| `avatars.<id>.hidden` | 是否隐藏 | boolean | false | none | setter 调 `remove` / `restoreBuiltins` |

### 6.4 MCP Store（mcp-store）

| key | label | schema | readonly | notify | 说明 |
|-----|-------|--------|----------|--------|------|
| `mcp-store` | 已安装 MCP（根） | array<McpConfig> | false | none | — |
| `mcp-store.<name>.env` | 环境变量 | object<string,string> | 内置 true/其他 false | related-agents（所有使用该 MCP 的 primary + templates） | 改 env 要重启 agent |
| `mcp-store.<name>.args` | 启动参数 | array<string> | 内置 true/其他 false | related-agents | 同上 |
| `mcp-store.<name>.command` | 命令 | string | 内置 true/其他 false | related-agents | 同上 |

### 6.5 通知配置（notification）

> 单例（`NotificationConfig id='default'`）

| key | label | schema | readonly | notify | 说明 |
|-----|-------|--------|----------|--------|------|
| `notification.mode` | 通知模式 | enum(`direct`\|`proxy_all`\|`custom`) | false | primary | 主 Agent 需要感知"代理模式"切换 |
| `notification.rules` | 自定义规则 | array<CustomRule> | false | primary | 同上 |

### 6.6 可见性（visibility）

| key | label | schema | readonly | notify | 说明 |
|-----|-------|--------|----------|--------|------|
| `visibility.rules` | 可见性规则（根） | array<VisibilityRule> | false | primary | — |

### 6.7 CLI（cli，只读）

| key | label | schema | readonly | notify | 说明 |
|-----|-------|--------|----------|--------|------|
| `cli` | CLI 列表 | array<CliInfo> | **true** | none | setter 抛 `readonly`，仅供搜索定位 |
| `cli.<name>.available` | 是否可用 | boolean | **true** | none | — |
| `cli.<name>.version` | 版本 | string | **true** | none | — |

**合计**：静态条目约 13 条，列表型按当前数据展开约 20~40 条，总规模 < 80 条。

---

## 7. Settings MCP 工具

注册到 `mcp-primary/tools/registry.ts`，与 `create_leader` / `send_to_agent` / `list_addresses` / `get_team_status` 并列。

### 7.1 `search_settings`

```ts
inputSchema: {
  type: 'object',
  properties: {
    q: { type: 'string', description: '自然语言搜索词，中英文皆可' },
    limit: { type: 'number', description: '默认 20', minimum: 1, maximum: 50 }
  },
  required: ['q'],
  additionalProperties: false,
}
// 返回
{
  results: Array<{
    key: string;
    label: string;
    description: string;
    category: SettingCategory;
    schema: SettingSchema;
    readonly: boolean;
    currentValue: unknown;      // 调 getter 取
    notify: 'none' | 'primary' | 'related-agents';
  }>,
  total: number
}
```

**实现**：调 `registry.search(q, limit)` → map 时补 `currentValue` + 扁平化 `notify`（把 `related-agents` object 化成字符串，避免 JSON schema 里的 resolver 函数泄漏）。

### 7.2 `call_setting`（统一调用入口：直接设置 / 弹界面）

```ts
inputSchema: {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Setting key（从 search_settings 结果获取）' },
    mode: { type: 'string', enum: ['direct', 'show'], description: 'direct=直接设置 show=弹界面给用户' },
    value: { description: '仅 mode=direct 时必填，任意 JSON，服务端按 entry.schema 做基本类型校验' },
    reason: { type: 'string', description: '仅 mode=show 时可选，告诉用户为什么弹这个设置' },
  },
  required: ['key', 'mode'],
  additionalProperties: false,
}
// mode=direct 返回
{ ok: true, key, oldValue, newValue } | { error: 'not_found' | 'readonly' | 'invalid' | string }
// mode=show 返回（立即，fire-and-forget，不等用户）
{ opened: true } | { error: 'not_found' }
```

**实现**：
- `mode === 'direct'`：调 `registry.write(key, value, { kind: 'agent', id: <primary_id> })`。actor 来自 `PrimaryMcpEnv`。
- `mode === 'show'`：调 `registry.get(key)` 校验存在性 → `wsBroadcaster.pushToUser({ type: 'show_setting', key, reason })` → 立即返回 `{ opened: true }`，不等用户操作。用户改完后走正常 HTTP/WS 保存路径，通知机制自动兜住。

**agent 决策流程**：用户给了具体值 → `mode: 'direct'`；用户没给具体值或需要确认 → `mode: 'show'`。

### ~~7.3 `show_setting`~~ — 已合并到 `call_setting`

> 原独立工具 `show_setting` 和 `update_setting` 合并为一个 `call_setting`，通过 `mode` 参数区分。见上方 §7.2。

---

## 8. show_setting 前端联动

### 8.1 新增 WS 下行事件

```ts
// packages/backend/src/ws/protocol.ts 扩 WsDownstream
export interface WsShowSetting {
  type: 'show_setting';
  key: string;
  reason?: string;
}
export type WsDownstream =
  | WsEventDown
  | WsGapReplay
  | WsPong
  | WsAck
  | WsErrorDown
  | WsSnapshot
  | WsGetTurnsResponse
  | WsGetTurnHistoryResponse
  | WsShowSetting;   // 新增
```

### 8.2 Broadcaster 扩 `pushToUser`

`ws-broadcaster.ts` 本来按订阅 filter 推 `event`。show_setting 不是 bus 事件，走独立 API：

```ts
class WsBroadcaster {
  // 新增：按 principal userId 推送任意 WsDownstream；找不到连接静默丢。
  pushToUser(userId: string, msg: WsDownstream): void;
}
```

单用户场景 `userId = 'local'`，从 `user-session` 拿当前活跃 userId，遍历 `clients` 匹配 `principal.kind === 'user' && principal.userId === userId` 的连接逐一 `ws.send`。

### 8.3 前端行为

- `useWsEvents` 收到 `type === 'show_setting'` → 调 `settingsStore.openPanel(key, reason)`
- 设置面板按 `category` 滚动到对应分组，高亮对应字段
- 用户改完点保存 → 走现有 HTTP 或将来的 WS `update_setting` op（不在本期）

---

## 9. 模块拆分 + 文件结构

```
packages/backend/src/
├── settings/
│   ├── types.ts                      — SettingEntry / SearchResult / NotifyPolicy / SettingSchema
│   ├── registry.ts                   — SettingsRegistry 类 + materialize + search + write
│   ├── notify.ts                     — dispatchNotify（primary / related-agents 分支）
│   ├── search-score.ts               — 分词 + 打分（独立成模块方便单测）
│   ├── entries/
│   │   ├── index.ts                  — registerAllEntries(registry, deps)
│   │   ├── primary-agent.ts          — 6 条
│   │   ├── templates.ts              — 列表型 5xN + 根 1 条
│   │   ├── avatars.ts                — 根 + <id>.hidden
│   │   ├── mcp-store.ts              — 根 + env/args/command
│   │   ├── notification.ts           — mode + rules
│   │   ├── visibility.ts             — rules
│   │   └── cli.ts                    — 根 + <name>.available/version（全只读）
│   └── __tests__/
│       ├── registry.test.ts
│       ├── search-score.test.ts
│       ├── notify.test.ts
│       └── entries/*.test.ts         — 每个模块一个，验证 getter/setter 不绕过 DAO
├── mcp-primary/
│   └── tools/
│       ├── search_settings.ts        — 新增
│       ├── update_setting.ts         — 新增
│       ├── show_setting.ts           — 新增
│       └── registry.ts               — 扩 ALL_TOOLS（+3 条）
├── ws/
│   ├── protocol.ts                   — 加 WsShowSetting
│   └── ws-broadcaster.ts             — 加 pushToUser(userId, msg)
└── http/
    └── server.ts                     — bootSubscribers 阶段构造 registry 并注入 mcp-primary tools
```

### 9.1 依赖注入约束

- registry 不 import 任何业务运行时（`bus` / `commRouter` / driver），只 import type。
- `entries/*.ts` 只依赖本模块的 repo / manager + registry 的 `register` 方法。
- `notify.ts` 仅依赖 `CommRouter` + `buildEnvelope` + type。
- 运行时装配（构造 registry → register 所有 entries → 注入 mcp-primary tools）放 `http/server.ts`，与 `bootSubscribers` 同阶段。

### 9.2 行数预算（硬约束）

- `registry.ts` ≤ 150
- `notify.ts` ≤ 120
- `search-score.ts` ≤ 100
- 每个 `entries/*.ts` ≤ 120（templates 可能略超，拆 resolver 到独立文件）
- 每个 MCP tool 文件 ≤ 80

---

## 10. 实施任务拆解

### Wave 1：非业务基础（可并行 5 人）

- **W1-A** `settings/types.ts`（估 0.5h）
- **W1-B** `settings/search-score.ts` + 单测（估 2h）
- **W1-C** `settings/registry.ts` + 单测（估 3h，靠 mock entry）
- **W1-D** `ws/protocol.ts` 扩 `WsShowSetting` + guards + 单测（估 1h）
- **W1-E** `ws/ws-broadcaster.ts` 扩 `pushToUser` + 单测（估 1.5h）

### Wave 2：各模块 entries（可并行 7 人，依赖 W1-C）

- **W2-A** `entries/primary-agent.ts` + 单测（估 1.5h）
- **W2-B** `entries/templates.ts` + resolver + 单测（估 2.5h）
- **W2-C** `entries/avatars.ts` + 单测（估 1h）
- **W2-D** `entries/mcp-store.ts` + 单测（估 1.5h）
- **W2-E** `entries/notification.ts` + 单测（估 1h）
- **W2-F** `entries/visibility.ts` + 单测（估 1h）
- **W2-G** `entries/cli.ts`（只读） + 单测（估 0.5h）

### Wave 3：通知 + MCP 工具（依赖 W1-C + W2-*）

- **W3-A** `settings/notify.ts` + 单测（估 2h）
- **W3-B** `mcp-primary/tools/search_settings.ts` + 单测（估 1h）
- **W3-C** `mcp-primary/tools/update_setting.ts` + 单测（估 1.5h）
- **W3-D** `mcp-primary/tools/show_setting.ts` + 单测（估 1h，用 fake broadcaster 验 pushToUser 调了）
- **W3-E** `mcp-primary/tools/registry.ts` 扩 ALL_TOOLS（估 0.5h）

### Wave 4：装配 + 集成测试（依赖全部 W2/W3）

- **W4-A** `http/server.ts` bootSubscribers 阶段装配 registry + 注入 mcp-primary（估 1.5h）
- **W4-B** 集成测试：主 Agent 通过 MCP `search_settings('系统提示词')` → 命中 → `update_setting` → `primary_agent.configured` 事件 emit（估 2h）
- **W4-C** 集成测试：`show_setting` → `pushToUser` 调到 → 前端收到下行 `show_setting`（估 1.5h）
- **W4-D** 集成测试：模板改 role → related-agents resolver 命中 → comm 发到正确 instanceId（估 2h）

### Wave 5：前端（独立节奏，可在 Wave 1 后就开）

- **W5-A** renderer 新增 `settingsStore`（估 2h）
- **W5-B** `useWsEvents` 监听 `show_setting` → settingsStore.openPanel（估 1h）
- **W5-C** 设置面板页面 + 按 category 分组渲染 + 字段高亮（估 6h，依赖组件库）
- **W5-D** 接入后端 HTTP（已有）+ 未来扩的 WS update_setting op（估 3h）

**合计**：后端 25h + 前端 12h ≈ 4.5 人日（并行压缩到 ~1.5 天）

---

## 11. 风险 & 取舍

| 风险 | 评估 | 应对 |
|------|------|------|
| Agent 误改 systemPrompt 把自己改废 | 中 | `update_setting` 改 `primary-agent.systemPrompt` 时额外 log 一条；后续考虑加 `confirm` 字段 |
| related-agents resolver 调 DAO 导致 N+1 | 低（当前 agent 数 < 50） | 监控阶段看日志再决定是否加缓存 |
| 列表型 key（`templates.<name>.*`）里 `<name>` 被删后再访问 | 中 | `materialize` 每次重建，已自然排除；但 search 结果里 `key` 返回后 agent 可能晚一步 `update_setting` → `{ error: 'not_found' }` 兜底 |
| show_setting fire-and-forget 永远不知道用户改没改 | 预期行为 | 不管。用户改了走正常通知链路；没改就没响应，符合"立即返回"语义 |
| registry 初始化顺序：CliManager 还没 boot 就 materialize | 低 | `getAll()` 已返白名单 + available=false 兜底，不抛 |
| notify 发给 actor 自己造成回环 | 已处理 | `dispatchNotify` 第一步判 `actor.kind === 'agent' && actor.id === targetId` 跳过 |

---

## 12. 设计不处理的延展（显式列出，避免 scope 蔓延）

- **MCP Store 的 install/uninstall HTTP**：本期 setter 可用但没有 HTTP 路由，Agent 要新装一个 MCP 只能走 `update_setting` 的"批量替换 mcp-store 根"。补 HTTP 是下一 Phase。
- **通知配置的 HTTP**：同上。
- **权限模型**：Agent A 能不能改 Agent B 的模板？本期全部视为用户授权，不加校验。
- **配置审计日志**：`update_setting` 成功后只 emit 现有模块的 bus 事件，不额外写审计表。
- **前端 WS update_setting op**：本期前端改设置仍走 HTTP；WS op 留给后续节省一次 RTT。
- **search 向量化**：当前纯 token 打分；如果后续条目膨胀到 1k+，再引入 embedding。

---

## 13. 论证小结：为什么"现有模块不用改"

| 现有模块 | 新增写需求 | 现状是否已满足 | 结论 |
|---------|-----------|----------------|------|
| primary-agent/repo | systemPrompt / mcpConfig / cliType etc. | `upsertConfig(PrimaryAgentConfig)` 已支持所有字段 | 不改 |
| role-template | role / persona / availableMcps... | `RoleTemplate.update(name, patch)` 已支持所有 patch | 不改 |
| mcp-store/store | env / args / command | `install(config)` 覆盖写 + `uninstall` 删除，可组合出 patch 语义 | 不改 |
| avatar/repo | hidden（隐藏/恢复）| `remove` + `restoreBuiltins` 已具备 | 不改 |
| notification-store | mode / rules | `upsert(cfg)` 支持整体替换 | 不改 |
| filter-store | rules | `upsert` / `remove` 已具备 | 不改 |
| cli-scanner | — | 只读 | 不改 |

**唯一要改的外部模块**：`ws/protocol.ts`（加一条下行事件类型）+ `ws/ws-broadcaster.ts`（加 `pushToUser` 方法）。这两处是本期 MCP `show_setting` 的前端联动必需品，不是"为了统一设置而重构现有模块"。

---

## 14. 红线 & 落地约束

- **严禁 git stash**
- **本文档只设计不改代码**
- 方案 A：**零改动既有 DAO / HTTP / bus 事件链**
- 新增 settings/ 目录严格遵守行数预算
- 所有 entries 必须有单测验证 setter 走 DAO 路径（反模式禁令：禁止 setter 直接读写 DB）
- 装配阶段（`http/server.ts`）新增代码 ≤ 30 行
