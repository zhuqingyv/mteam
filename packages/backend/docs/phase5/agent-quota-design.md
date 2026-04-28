# Agent 上限配额设计（Phase 5）

> 范围：给系统加一个"同时存活的 agent 实例数"硬上限。超限时创建入口返回结构化错误，由主 Agent 自行决策（通知用户 / 等待 / 放弃）。上限通过 Settings Registry 统一配置。

---

## 1. 入口清单与收口点

### 1.1 生产代码创建实例的唯一入口

grep `RoleInstance.create` 全仓（生产代码，排除 `*.test.ts`）只有**一处**：

- `src/api/panel/role-instances.ts::handleCreateInstance` — 入库 + emit `instance.created`。

所有上层都通过 HTTP `POST /api/role-instances` 汇入这里：

| 调用方 | 路径 | 文件 |
|---|---|---|
| HTTP 路由（前端/面板/测试） | `POST /api/role-instances` → `handleCreateInstance` | `src/http/routes/instances.routes.ts:23` |
| 面板门面转发 | `POST /api/panel/instances/*` → `/api/role-instances/*` | `src/http/routes/panel.routes.ts:30-35` |
| mteam-primary MCP | `httpJson POST /api/role-instances` | `src/mcp-primary/tools/create_leader.ts:54-60` |
| mteam MCP（leader） | `httpJson POST /api/role-instances` | `src/mcp/tools/add_member.ts:59-71` |
| 测试 helper | `apiCall POST /api/role-instances` | `src/__tests__/helpers/ws-test-helpers.ts:45` |

**结论**：`handleCreateInstance` 是唯一真实入口，配额检查放在此函数即可做到**零遗漏**。HTTP 层、MCP 层都会被同一次检查覆盖。

### 1.2 不属于 agent 配额的实体（排除项）

- **Primary Agent** — 存在 `primary_agent` 表（单例）、走 `PrimaryAgent.configure/start`（`src/primary-agent/primary-agent.ts:82,106`），不占用 `role_instances` 行。产品上主 Agent 是"秘书+总机"，**不计入配额**。
- **ProcessManager.byPid Map**（`src/process-manager/manager.ts:40`）— 进程级台账，维度是 OS PID，会包含 primary agent + 所有 member driver 子进程，**不用于配额统计**（粒度错位：一个 instance 可能短暂有 0 或 1 个进程在 spawn 中）。
- `team.member_joined` 只是把已有 instance 加入 team，**不新建实例**。
- 测试文件里的 `RoleInstance.create` 不走配额（测试直接操作 domain 层）。

### 1.3 member-driver 自动创建？

读 `src/bus/subscribers/member-driver/lifecycle.ts`：它订阅 `instance.created` 事件后 spawn OS 进程，但**不会反向创建新的 role_instance**。真正的"新增 agent"只有上面列的一处。

---

## 2. 方案：Domain 层收口 + Settings Registry 配置

### 2.1 配额检查放在哪一层

**选择：Domain 层（`RoleInstance.create` 内部）。** 

理由：
1. Domain 层是最底层的真相。HTTP handler 层虽然也收口，但任何未来新加的内部调用（比如某个迁移脚本直接 `RoleInstance.create`）都会绕过 handler 检查。
2. 数据一致性：`RoleInstance.create` 里已经用 `db.transaction` 做原子插入（`src/domain/role-instance.ts:95-99`）。把 `COUNT(*)` 放在事务内，天然避免并发超限。
3. 对现有调用方零侵入：`handleCreateInstance` 只需 catch 新抛的 `QuotaExceededError`，翻译成 HTTP 409 + JSON 体。

**不选 HTTP handler 层**：`RoleInstance.create` 暴露给 mcp-primary / mcp / 测试 helper，未来如果新增一条绕过 HTTP 的路径（例如内部 bootstrap）会漏检。

**不选 MCP 工具层**：`create_leader` / `add_member` 之间各自校验会写两遍，且 HTTP direct 调用仍漏。

### 2.2 统计怎么算

**选择：`SELECT COUNT(*) FROM role_instances`（不加 status 过滤）。**

`role_instances` 表生命周期：
- `handleCreateInstance` 插入 → status='PENDING'
- `handleActivate` / `register_session` → 'ACTIVE'
- `handleRequestOffline` → 'PENDING_OFFLINE'
- `handleDeleteInstance` → DELETE（行被移除）

三态全都是"还占着坑"的 agent——PENDING 会自动起 driver，PENDING_OFFLINE 还没删除、driver 刚 stop 完成即将 delete。没有"软删除"中间态。**`COUNT(*)` 就是在场实例数**。

不走内存计数器的原因：
- HTTP server 可能多实例（未来水平扩展）；内存计数器要加 IPC 同步，远不如 SQL 原子。
- 事务内 `COUNT` + `INSERT` 可天然串行化，不需要自己做锁。
- 测试启动 / 进程重启时内存计数器要从 DB 重建，容易出现窗口期偏差。

**实现草图**（`src/domain/role-instance.ts`）：

```ts
static create(input: CreateRoleInstanceInput): RoleInstance {
  const db = getDb();
  // ... 其它字段准备 ...
  const instance = db.transaction(() => {
    const maxAgents = readMaxAgents();   // 见 §2.4
    if (maxAgents > 0) {
      const { c } = db.prepare('SELECT COUNT(*) AS c FROM role_instances').get() as { c: number };
      if (c >= maxAgents) {
        throw new QuotaExceededError({ current: c, limit: maxAgents });
      }
    }
    stmt.insertRow().run(/* ... */);
    stmt.insertCreateEvent().run(/* ... */);
    return new RoleInstance(/* ... */);
  })();
  return instance;
}
```

> SQLite 默认 serialized 事务（`BEGIN DEFERRED`），此处的 `COUNT + INSERT` 足够防止并发双写超限（两个并发事务中一个会因写锁 busy 失败重试）。如果未来并发压力大可改 `BEGIN IMMEDIATE`，本期不改。

### 2.3 超限返回什么（error schema）

**`QuotaExceededError` 类**（`src/domain/errors.ts` 新建 or 放 `role-instance.ts`）：

```ts
export class QuotaExceededError extends Error {
  readonly code = 'QUOTA_EXCEEDED';
  readonly current: number;
  readonly limit: number;
  readonly resource = 'agent';
  constructor(info: { current: number; limit: number }) {
    super(`agent quota exceeded: current=${info.current}, limit=${info.limit}`);
    this.current = info.current;
    this.limit = info.limit;
  }
}
```

**HTTP 层翻译**（`handleCreateInstance`）：

```ts
try {
  instance = RoleInstance.create(input);
} catch (err) {
  if (err instanceof QuotaExceededError) {
    return { status: 409, body: {
      error: err.message,
      code: 'QUOTA_EXCEEDED',
      resource: 'agent',
      current: err.current,
      limit: err.limit,
    }};
  }
  throw err;
}
```

**MCP 层翻译**（create_leader / add_member）：`httpJson` 收到 409 会把 body 放在 `res.error`，但结构化字段会丢。按 `createLeader.ts` 现有的"模板不存在附可用模板"模式，加一个 409 分支：

```ts
if (createRes.status === 409 && createRes.body && typeof createRes.body === 'object'
    && (createRes.body as any).code === 'QUOTA_EXCEEDED') {
  const b = createRes.body as { current: number; limit: number; error: string };
  return {
    error: b.error,
    code: 'QUOTA_EXCEEDED',
    current: b.current,
    limit: b.limit,
    hint: 'ask user to disband an existing team / increase system.maxAgents',
  };
}
```

主 Agent 拿到带 `code=QUOTA_EXCEEDED` 的结构化错误后，自己决定：
- 发通知告诉用户（见方案 2 的 `quota_limit` 通知类型）
- 等某个现有任务结束
- 放弃本次创建

**注意**：`httpJson` 当前实现需要确认透传 response body。若它只透传 `error` 字段会丢结构，建议补一个 `errorBody` 字段。这部分在实施时再细化。

### 2.4 配置存哪（Settings Registry）

**新增 `src/settings/entries/system.ts`**，注册一条 `system.maxAgents` entry：

```ts
import type { SettingEntry } from '../types.js';
import { readMaxAgents, writeMaxAgents } from '../../system/quota-config.js';

export const systemEntries: SettingEntry[] = [
  {
    key: 'system.maxAgents',
    label: 'Agent 并发上限',
    description: '同时存活的角色实例总数上限（含 PENDING/ACTIVE/PENDING_OFFLINE）。0 表示不限制。超限时 create_leader / add_member 返回 QUOTA_EXCEEDED。',
    category: 'system',
    schema: { type: 'integer', minimum: 0, maximum: 1000 },
    readonly: false,
    notify: 'primary',      // 改动时通知主 Agent
    keywords: ['quota', 'limit', '并发', '上限', '配额'],
    getter: () => readMaxAgents(),
    setter: (value: unknown) => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error('system.maxAgents must be non-negative integer');
      }
      writeMaxAgents(value);
    },
  },
];
```

然后在 `src/settings/entries/index.ts` 的 `ALL_SETTING_ENTRIES` 数组加上 `...systemEntries`。

**存储层 `src/system/quota-config.ts`**：
- 建议**复用** `notification_configs` 的简单模式：新建一张 `system_configs(key TEXT PK, value_json TEXT, updated_at)` 表。原因：未来还会有其他系统级单键配置（心跳间隔、retry 次数等），直接用新表比往 `primary_agent`/其他业务表里塞更清晰。
- DAO 只暴露 `readMaxAgents(): number` 和 `writeMaxAgents(n: number): void`；读缓存一份在模块内存、写后覆盖缓存（避免每次 create 都查 DB）。

Schema（`src/db/schemas/system_configs.sql`）：

```sql
CREATE TABLE IF NOT EXISTS system_configs (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 2.5 默认值

**建议默认 50。不设 0（不限）。**

理由：
- 本地单机场景 50 已经远超正常用量（一个 team 里不常超过 10 人，同时活跃 5 个 team 就是 50）。
- 资源保底：每个 member driver = 1 个 claude/codex CLI 子进程 + ACP newSession 会 spawn 全新 claude CLI（见 mnemo #702，启动 5-7s）。50 个已经会把 macOS 的句柄 / 内存打得挺满。
- 用户明确要扩到更大时走 `call_setting({ key: 'system.maxAgents', value: 100 })`——有显式声明比默认放水更安全。

> 如果团队倾向"默认不限，只提供 MCP 工具"，改成默认 0 也能工作——getter 里 0 就跳过检查。不建议，因为"主 Agent 自动组队"场景下 agent 可能被无意识拉起到几十上百个。

### 2.6 和 ProcessManager 的关系

- **ProcessManager** 管的是 OS 进程（`byPid` Map），不是 role_instance。它用于：
  - `killAll()` — 优雅关闭所有子进程（`src/process-manager/manager.ts:84`）
  - `stats().count` — 观测当前存活进程数
  - snapshot 快照 — 崩溃恢复用
- **Agent 配额**管的是 `role_instances` 行数，两者粒度不同（primary_agent 的子进程也计入 byPid）。
- **协同点**：super-limit 的硬兜底可以顺便看 processManager.stats().count，但这是次要 signal，不作为主要判定。
- 未来若想做"按进程占用 RAM/CPU 自动限流"，可以基于 processManager 的 stats 做二级限流，这是 Phase 5 之后的事。

---

## 3. 需要修改 / 新增的文件清单

新增：
- `src/system/quota-config.ts` — DAO，`readMaxAgents / writeMaxAgents` + 内存缓存
- `src/system/quota-config.test.ts` — 单测
- `src/db/schemas/system_configs.sql`
- `src/settings/entries/system.ts` — SettingEntry 注册

改动：
- `src/domain/role-instance.ts::create` — 事务内加 COUNT + throw QuotaExceededError
- `src/domain/errors.ts`（或 role-instance.ts 内部） — 定义 QuotaExceededError
- `src/api/panel/role-instances.ts::handleCreateInstance` — catch 翻译 409
- `src/mcp-primary/tools/create_leader.ts` — 识别 409 QUOTA_EXCEEDED，返回结构化 error
- `src/mcp/tools/add_member.ts` — 同上
- `src/settings/entries/index.ts` — 加 `...systemEntries`
- `src/db/connection.ts` 或 schema 装配器 — 注册 `system_configs.sql`（按现有风格）

测试：
- `src/__tests__/role-instance-quota.test.ts` — 真 DB，验证 COUNT 精确、并发两次 create 有一次失败、limit=0 跳过、改 setting 后立即生效
- `src/__tests__/http-instances.test.ts` 补一个 409 body 形状 case
- `src/mcp-primary/tools/create_leader.test.ts` 补一个 409 上传给主 Agent 的 schema case

---

## 4. 决策对比 / 被否决方案

| 方案 | 收口点 | 否决原因 |
|---|---|---|
| handler 层检查 | `handleCreateInstance` | 绕过风险（未来可能有人直接调 Domain） |
| 内存计数器 | `RoleInstance.create` 里维护 static `activeCount` | 多进程漂移、重启需要从 DB 重建、测试环境要重置 |
| 独立 `quota-service` | 单独模块 + 独立 API | 增加一层无必要的抽象；本期一条规则一个数字，直接写 domain |
| Settings Registry 不含 system.maxAgents | 走 env / 硬编码 | 配置面板已是事实标准，一致性优先 |

---

## 5. 红线与兼容性

- **兼容**：0 = 不限制（灰度 / 开发环境），默认 50 对现有单元测试一般没影响（多数用例创建 < 5 个）。对创建 > 50 的旧测试需要调大默认或显式设 0。
- **幂等**：`upsertConfig` 语义重复写同值不报错，SettingEntry setter 用 >= 0 校验。
- **不落实际数字到 `primary_agent` / 其它业务表**：单独 `system_configs` 表让"系统级 vs 业务级"配置物理隔离，避免未来跨项目脏数据。

---

## 6. 验收判据

1. `system.maxAgents=2` 时，连续三次 POST `/api/role-instances` 第三次返回 409 + `{ code:'QUOTA_EXCEEDED', current:2, limit:2 }`。
2. 删除一个（`DELETE /api/role-instances/:id`）后再 create 成功。
3. `call_setting({ key:'system.maxAgents', value:0 })` 后立即可以无限创建。
4. `search_settings({ q:'quota' })` 命中 `system.maxAgents`。
5. `create_leader` MCP 工具超限时返回 `{ error, code, current, limit, hint }` 给主 Agent。
6. `add_member` MCP 工具同上（leader 触达）。
7. 单测：并发 10 次 create，`maxAgents=5`，最终 DB 只有 5 行，其余 5 次抛错。
