# V2 Phase 1 — 项目结构设计

> 本文档定义 V2 首阶段（role_templates + role_instances + 状态机 + 事件）的目录结构、
> 文件职责、接口签名、DB 层与字段映射规则。
> 仅覆盖 Phase 1 范围：模板 / 实例 / 状态机 / 事件总线 / SQLite 连接。
> teams、projects、messages、governance 等业务在后续 Phase 扩展，不在本文件讨论。

---

## 1. V2 目录结构树

```
packages/mcp-server/src/v2/
├── docs/
│   └── phase1/
│       ├── README.md                # 完整数据库设计（已有）
│       └── project-structure.md     # 本文档
├── db/
│   ├── connection.ts                # SQLite 连接单例 + apply schemas/
│   └── schemas/                     # 每张表一个 SQL 文件
│       ├── role_templates.sql
│       ├── role_instances.sql
│       ├── role_state_events.sql
│       ├── teams.sql
│       ├── team_members.sql
│       ├── projects.sql
│       ├── project_members.sql
│       ├── project_rules.sql
│       ├── messages.sql
│       ├── governance.sql
│       └── schema_version.sql
├── domain/
│   ├── state-machine.ts             # 状态枚举 + 转换规则 + resolveTransition
│   ├── role-template.ts             # RoleTemplate Active Record
│   ├── role-instance.ts             # RoleInstance Active Record
│   └── events.ts                    # EventEmitter（状态变更事件）
└── index.ts                         # 统一导出
```

Phase 1 不新建 `team.ts / project.ts / message.ts / governance.ts`，留到 Phase 2。
`db-schema.sql` 拆成 `v2/db/schemas/` 下每张表一个文件。`connection.ts` 启动时按顺序读所有 `.sql` 文件执行。

---

## 2. 每个文件职责 + 预估行数

| 文件 | 职责 | 预估行数 |
|------|------|--------:|
| `db/schemas/*.sql` | 每张表一个 SQL 文件（11 个），各含 CREATE TABLE + INDEX | 各 ~20 |
| `db/connection.ts` | `openDb(path)` 打开 better-sqlite3 句柄；设置 PRAGMA；按顺序读 `schemas/` 下所有 `.sql` apply；写入 `schema_version`；导出 `getDb()` 单例 | ~80 |
| `domain/state-machine.ts` | `RoleStatus` / `TransitionEvent` 枚举；`TRANSITIONS` 常量表；`resolveTransition()`；`IllegalTransitionError` | ~90 |
| `domain/role-template.ts` | `RoleTemplate` 类：create / findByName / listAll / update / delete / toJSON | ~140 |
| `domain/role-instance.ts` | `RoleInstance` 类：create / findById / findActiveByMember / listActive / transition / destroy / 各 setter / toJSON；transition 内部写 `role_state_events` 并 emit 事件 | ~190 |
| `domain/events.ts` | 全局 `EventEmitter`（node `events`）；定义事件名常量：`role:transition` / `role:created` / `role:destroyed` | ~40 |
| `index.ts` | 统一导出上述类、枚举、事件总线 | ~20 |

所有 `.ts` 文件严格 **< 200 行**，超出必须拆分。

---

## 3. 接口设计

### 3.1 state-machine.ts

```ts
export enum RoleStatus {
  PENDING         = 'PENDING',
  ACTIVE          = 'ACTIVE',
  PENDING_OFFLINE = 'PENDING_OFFLINE',
}

export enum TransitionEvent {
  REGISTER_SESSION = 'register_session',
  REQUEST_OFFLINE  = 'request_offline',
  DEACTIVATE       = 'deactivate',
  CRASH            = 'crash',
}

export interface TransitionRule {
  event: TransitionEvent;
  from: RoleStatus[];
  to: RoleStatus | null;   // null 表示物理删除
  /** 目标为物理删除时 true */
  terminal?: boolean;
}

export const TRANSITIONS: readonly TransitionRule[];

/**
 * 根据当前状态和事件解析出目标状态。
 * @throws IllegalTransitionError 如果 (from, event) 不存在合法转换
 */
export function resolveTransition(
  from: RoleStatus,
  event: TransitionEvent,
): { to: RoleStatus | null; terminal: boolean };

export class IllegalTransitionError extends Error {
  readonly from: RoleStatus;
  readonly event: TransitionEvent;
  constructor(from: RoleStatus, event: TransitionEvent);
}
```

**转换表**（与 Phase 2 状态机一致）：

| event | from | to | terminal |
|-------|------|-----|:--------:|
| register_session  | `[PENDING]`                                    | ACTIVE          | - |
| request_offline   | `[ACTIVE]`                                     | PENDING_OFFLINE | - |
| deactivate        | `[PENDING_OFFLINE]`                            | （物理删除）     | Y |
| crash             | `[PENDING, ACTIVE, PENDING_OFFLINE]`           | （物理删除）     | Y |

权限：`request_offline` 由上层 handler 校验调用者 `is_leader=1`，状态机本身不懂权限。

---

### 3.2 role-template.ts

```ts
export interface RoleTemplateProps {
  name: string;
  role: string;
  description?: string | null;
  persona?: string | null;
  availableMcps: string[];
  createdAt: string;  // ISO
  updatedAt: string;  // ISO
}

export interface CreateRoleTemplateInput {
  name: string;
  role: string;
  description?: string | null;
  persona?: string | null;
  availableMcps?: string[];
}

export interface UpdateRoleTemplateInput {
  role?: string;
  description?: string | null;
  persona?: string | null;
  availableMcps?: string[];
}

export class RoleTemplate {
  readonly name: string;
  role: string;
  description: string | null;
  persona: string | null;
  availableMcps: string[];
  readonly createdAt: string;
  updatedAt: string;

  private constructor(props: RoleTemplateProps);

  /** INSERT；name 冲突抛错 */
  static create(input: CreateRoleTemplateInput): RoleTemplate;

  /** SELECT by PK；不存在返回 null */
  static findByName(name: string): RoleTemplate | null;

  /** SELECT all，按 created_at ASC */
  static listAll(): RoleTemplate[];

  /** 同名 UPDATE；自动刷新 updated_at */
  static update(name: string, patch: UpdateRoleTemplateInput): RoleTemplate;

  /** DELETE by PK；若被实例引用则抛外键错（交给 SQLite） */
  static delete(name: string): void;

  toJSON(): RoleTemplateProps;
}
```

---

### 3.3 role-instance.ts

```ts
export interface RoleInstanceProps {
  id: string;
  templateName: string;
  memberName: string;
  isLeader: boolean;
  teamId: string | null;
  projectId: string | null;
  status: RoleStatus;
  statusSince: string;
  sessionId: string | null;
  sessionPid: number | null;
  leaderName: string | null;
  task: string | null;
  createdAt: string;
  destroyedAt: string | null;
  destroyReason: string | null;
}

export interface CreateRoleInstanceInput {
  templateName: string;
  memberName: string;
  isLeader?: boolean;
  teamId?: string | null;
  projectId?: string | null;
  leaderName?: string | null;
  task?: string | null;
  /** 可选：外部注入 id（主要用于测试）；默认 randomUUID() */
  id?: string;
}

export interface TransitionOptions {
  actor?: string | null;
  reason?: string | null;
}

export class RoleInstance {
  readonly id: string;
  readonly templateName: string;
  readonly memberName: string;
  readonly isLeader: boolean;
  teamId: string | null;
  projectId: string | null;
  status: RoleStatus;
  statusSince: string;
  sessionId: string | null;
  sessionPid: number | null;
  leaderName: string | null;
  task: string | null;
  readonly createdAt: string;
  destroyedAt: string | null;
  destroyReason: string | null;

  private constructor(props: RoleInstanceProps);

  /** INSERT，初始 status=PENDING；同事务写首条 role_state_events(from=NULL,to=PENDING) */
  static create(input: CreateRoleInstanceInput): RoleInstance;

  /** SELECT by id；不存在返回 null */
  static findById(id: string): RoleInstance | null;

  /** 按 memberName 查所有存活实例（行存在即存活） */
  static findActiveByMember(memberName: string): RoleInstance[];

  /** 全部存活实例，按 created_at DESC */
  static listActive(): RoleInstance[];

  /**
   * 原子事务：resolveTransition → (UPDATE role_instances 或 DELETE) → INSERT role_state_events。
   * 若目标为终态（deactivate / crash），**物理删除行** + 写 state_event + emit 'role:destroyed'。
   * 非终态：UPDATE status/status_since + 写 state_event + emit 'role:transition'。
   */
  transition(event: TransitionEvent, opts?: TransitionOptions): void;

  /** transition(DEACTIVATE) 的语义糖 */
  destroy(reason?: string): void;

  /** 以下 setter 均 UPDATE 单字段 + 回填内存；不走状态机 */
  setSessionId(sessionId: string | null): void;
  setSessionPid(pid: number | null): void;
  setTask(task: string | null): void;
  setTeamId(teamId: string | null): void;
  setProjectId(projectId: string | null): void;

  toJSON(): RoleInstanceProps;
}
```

`transition()` 内部伪码：

```ts
const { to, terminal } = resolveTransition(this.status, event);
const now = new Date().toISOString();
db.transaction(() => {
  if (terminal) {
    // 物理删除路径：deactivate / crash
    db.prepare(`INSERT INTO role_state_events
                (instance_id, from_state, to_state, trigger_event, actor, reason, at)
                VALUES (?, ?, NULL, ?, ?, ?, ?)`).run(...);
    db.prepare(`DELETE FROM role_instances WHERE id=?`).run(this.id);
  } else {
    db.prepare(`UPDATE role_instances
                SET status=?, status_since=?
                WHERE id=?`).run(to, now, this.id);
    db.prepare(`INSERT INTO role_state_events
                (instance_id, from_state, to_state, trigger_event, actor, reason, at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...);
  }
})();
emitter.emit('role:transition', { instanceId: this.id, from: this.status, to, event, at: now });
if (terminal) emitter.emit('role:destroyed', { instanceId: this.id, at: now, reason });
```

注意：V2 的删除是**物理删除**，不再写 `destroyed_at` / `destroy_reason`（这两列已被移除，历史留存在 `role_state_events` 中）。

---

### 3.4 events.ts

```ts
import { EventEmitter } from 'node:events';

export const EVENTS = {
  ROLE_CREATED:     'role:created',
  ROLE_TRANSITION:  'role:transition',
  ROLE_DESTROYED:   'role:destroyed',
} as const;

export interface RoleCreatedEvent {
  instanceId: string;
  templateName: string;
  memberName: string;
  at: string;
}

export interface RoleTransitionEvent {
  instanceId: string;
  from: RoleStatus;
  to: RoleStatus;
  event: TransitionEvent;
  actor: string | null;
  reason: string | null;
  at: string;
}

export interface RoleDestroyedEvent {
  instanceId: string;
  at: string;
  reason: string | null;
}

/** 进程内单例；SSE / 日志 / 其他订阅者 on() 挂载 */
export const roleEvents: EventEmitter;
```

`RoleInstance.create()` 完成后 emit `role:created`；
`transition()` 完成后 emit `role:transition`；
若 `terminal=true` 额外 emit `role:destroyed`。

---

## 4. DB 层设计

### 4.1 connection.ts

```ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let handle: Database.Database | null = null;

export interface OpenDbOptions {
  /** 文件路径；':memory:' 表示内存库（测试用） */
  path: string;
  /** 是否只读；默认 false */
  readonly?: boolean;
}

export function openDb(opts: OpenDbOptions): Database.Database;
export function getDb(): Database.Database;  // 未 open 抛错
export function closeDb(): void;             // 测试清理用
```

初始化流程：

1. `new Database(path)` 打开句柄。
2. 设置 PRAGMA：
   - `journal_mode = WAL`（内存库自动降级为 MEMORY）
   - `foreign_keys = ON`
   - `busy_timeout = 5000`
   - `synchronous = NORMAL`
3. 读取 `v2/db/schema.sql` 全文。
4. `db.exec(sqlText)`：`CREATE TABLE IF NOT EXISTS` 保证幂等。
5. `INSERT OR IGNORE INTO schema_version(version, applied_at, note) VALUES (1, now, 'phase1')`。
6. 赋值 `handle` 并返回。

### 4.2 schema.sql apply

- 直接 `db.exec(readFileSync('v2/db/schema.sql','utf8'))`，**不走 migration 框架**。
- 所有 `CREATE` 都带 `IF NOT EXISTS`，多次启动幂等。
- Phase 1 只写 `schema_version = 1`。后续升级才引入迁移脚本目录。

### 4.3 支持 `:memory:` 测试

- `openDb({ path: ':memory:' })` 即得到全新内存库。
- 测试 setup：`beforeEach` 里 `openDb({ path: ':memory:' })`；`afterEach` 里 `closeDb()`。
- `handle` 是模块级单例，测试之间不共享，切换靠 close → open。
- 读环境变量 `TEAM_HUB_DB` 的解析不放在 `connection.ts`，由上层（`index.ts` 或启动脚本）决定传什么 path。`connection.ts` 只收参数、不读 env。

---

## 5. 字段映射规则

### 5.1 通用约定

- TypeScript 成员与接口字段：**camelCase**。
- SQLite 列名：**snake_case**。
- 时间戳：ISO 8601 字符串（`new Date().toISOString()`），不用 epoch 数字。
- 布尔：TS 用 `boolean`，SQL 列是 `INTEGER` (0/1)，读写时双向转换。
- JSON 字段：TS 侧是结构化类型（如 `string[]`），SQL 侧是 `TEXT`，读取时 `JSON.parse`、写入时 `JSON.stringify`。
- 可空字段：TS 用 `T | null`，避免 `undefined`。

### 5.2 `role_templates` 映射

| SQL 列 | TS 字段 | 类型转换 |
|--------|---------|----------|
| `name` | `name` | string |
| `role` | `role` | string |
| `description` | `description` | `string \| null` |
| `persona` | `persona` | `string \| null` |
| `available_mcps` | `availableMcps` | `JSON.parse` ↔ `JSON.stringify`；TS 侧 `string[]` |
| `created_at` | `createdAt` | string (ISO) |
| `updated_at` | `updatedAt` | string (ISO) |

### 5.3 `role_instances` 完整映射表

| SQL 列 | TS 字段 | TS 类型 | 转换说明 |
|--------|---------|---------|----------|
| `id` | `id` | `string` | UUID |
| `template_name` | `templateName` | `string` | FK → role_templates.name |
| `member_name` | `memberName` | `string` | |
| `is_leader` | `isLeader` | `boolean` | `INTEGER 0/1` ↔ `false/true` |
| `team_id` | `teamId` | `string \| null` | Phase 1 恒为 null |
| `project_id` | `projectId` | `string \| null` | Phase 1 恒为 null |
| `status` | `status` | `RoleStatus` | 枚举字符串，与 SQL CHECK 约束一致 |
| `status_since` | `statusSince` | `string` | ISO 时间 |
| `session_id` | `sessionId` | `string \| null` | UNIQUE |
| `session_pid` | `sessionPid` | `number \| null` | INTEGER |
| `leader_name` | `leaderName` | `string \| null` | |
| `task` | `task` | `string \| null` | |
| `created_at` | `createdAt` | `string` | ISO |
| `destroyed_at` | `destroyedAt` | `string \| null` | 非空即终态 |
| `destroy_reason` | `destroyReason` | `string \| null` | |

### 5.4 `role_state_events` 映射（仅内部读写，不对外暴露 Active Record）

| SQL 列 | TS 字段（内部 Row 类型） |
|--------|------------------------|
| `id` | `id: number` |
| `instance_id` | `instanceId: string` |
| `from_state` | `fromState: RoleStatus \| null` |
| `to_state` | `toState: RoleStatus` |
| `trigger_event` | `triggerEvent: TransitionEvent` |
| `actor` | `actor: string \| null` |
| `reason` | `reason: string \| null` |
| `at` | `at: string` |

---

## 6. 设计原则

1. **Active Record 模式**
   - 类自己持有 SQL：`RoleTemplate.create` / `RoleInstance.create` 直接 `db.prepare().run()`，不引入 DAO / Repository / Service 分层。
   - 静态方法 = 查询/创建入口；实例方法 = 修改自身行。
   - 内部可以封装 `private static fromRow(row)` 把 DB 行映射成实例，但不对外暴露。

2. **每文件 < 200 行**
   - 超过即拆：例如 `role-instance.ts` 若膨胀，可把 transition 子逻辑拆到 `role-instance-transition.ts` 同目录私有文件。
   - Phase 1 预估行数（见 §2）均在 200 行内，无需拆分。

3. **零外部依赖（除 `better-sqlite3`）**
   - `crypto.randomUUID()` 用 node 内置 `node:crypto`。
   - `EventEmitter` 用 `node:events`。
   - 时间用 `new Date().toISOString()`，不引入 dayjs / luxon。
   - 不引 zod / typebox（Phase 1 参数校验写手工 `if` 足够）。
   - 不引 knex / drizzle / typeorm / kysely。

4. **事务一律走 `db.transaction(fn)()`**
   - better-sqlite3 原生 API，无需手写 BEGIN/COMMIT。
   - transition、destroy、create（含首条 state_event）都在事务内。

5. **枚举值与 SQL CHECK 约束一一对应**
   - `RoleStatus.PENDING === 'PENDING'` 等枚举值与 schema.sql 的 `CHECK(status IN ('PENDING','ACTIVE','PENDING_OFFLINE'))` 完全一致。
   - 单测里断言枚举值集合与 CHECK 字符串集合相等，防漂移。

6. **Phase 1 明确不做**
   - teams / projects / messages / governance 的 Active Record 类 —— Phase 2。
   - HTTP server / MCP 工具 / Panel SSE —— 后续 Phase。
   - reaper / 心跳 / 锁 / 预约码 —— V2 整体不做。
   - 记忆 —— 交给 mnemo。

---

## 7. 验收示意（Phase 1 单测应能跑通）

```ts
import { openDb, closeDb } from './v2/db/connection';
import { RoleTemplate } from './v2/domain/role-template';
import { RoleInstance } from './v2/domain/role-instance';
import { TransitionEvent, RoleStatus } from './v2/domain/state-machine';
import { roleEvents, EVENTS } from './v2/domain/events';

openDb({ path: ':memory:' });

const tpl = RoleTemplate.create({
  name: '刺猬',
  role: 'qa',
  persona: '你是测试',
  availableMcps: ['mteam', 'mnemo'],
});

const inst = RoleInstance.create({
  templateName: tpl.name,
  memberName: '刺猬-01',
});

let transitions = 0;
roleEvents.on(EVENTS.ROLE_TRANSITION, () => transitions++);

inst.transition(TransitionEvent.REGISTER_SESSION);   // PENDING → ACTIVE
inst.transition(TransitionEvent.REQUEST_OFFLINE);    // ACTIVE → PENDING_OFFLINE
inst.transition(TransitionEvent.DEACTIVATE);         // PENDING_OFFLINE → 物理删除

// 断言：RoleInstance.findById(inst.id) === null（行已物理删除）
// 断言：role_state_events 4 条（create + 3 次 transition）
// 断言：transitions === 3
closeDb();
```
