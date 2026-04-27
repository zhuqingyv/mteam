# Team 模块技术方案

> 纯 DAO 原子模块，只管"谁和谁是一个组"这个关系。跟 roster 平级，不做业务编排。

## 0. TL;DR — 一分钟理解

- **team 是原子模块** — `class Team` 只读写 `teams` 和 `team_members` 两张表，**不做业务判断、不调用其他 domain**。
- **team 不绑 project** — `teams.project_id` 删除。project 是更高层的业务概念，未来由 project 模块 / 编排层自己管。
- **team_members 简化** — 去掉 `left_at` / `leave_reason`，当前成员 = DB 里的所有行。`role_instances` 删除时 CASCADE 级联删除。
- **联动走 bus** — 新建 `bus/subscribers/team.subscriber.ts`，订阅 `instance.deleted` 自动 `removeMember`；team 空了自动 `disband`。
- **HTTP API** — 参照 `api/panel/roster.ts` 风格，6 个端点挂在 `/api/teams`。

---

## 1. 现状分析

### 1.1 现有 schema

#### `packages/backend/src/db/schemas/teams.sql`（要改）

```sql
CREATE TABLE IF NOT EXISTS teams (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  leader_instance_id TEXT NOT NULL REFERENCES role_instances(id),
  project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,  -- ❌ 删除
  description      TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK(status IN ('active','disbanded')),
  created_at       TEXT NOT NULL,
  disbanded_at     TEXT
);

CREATE INDEX idx_teams_leader   ON teams(leader_instance_id);
CREATE INDEX idx_teams_project  ON teams(project_id);                 -- ❌ 删除
CREATE INDEX idx_teams_status   ON teams(status);
```

#### `packages/backend/src/db/schemas/team_members.sql`（要改）

```sql
CREATE TABLE IF NOT EXISTS team_members (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  instance_id      TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  role_in_team     TEXT,
  joined_at        TEXT NOT NULL,
  left_at          TEXT,                -- ❌ 删除（用 DELETE 代替软删）
  leave_reason     TEXT                 -- ❌ 删除
);

-- 现有索引有两个 WHERE left_at IS NULL 的局部索引，去掉 left_at 后要改。
```

### 1.2 其他文件现有引用

| 文件 | 是否引用 teams / team_members | 处理 |
|------|-----------------------------|------|
| `src/domain/role-instance.ts` | 只读写 `role_instances.team_id` 列，不碰 teams 表 | 不动 |
| `src/roster/roster.ts` | 通过 `role_instances.team_id` 做 scope=team 过滤 | 不动 |
| `src/api/panel/*.ts` | 无 team 相关 handler | 不动 |
| `src/bus/subscribers/*.ts` | 无 team 相关 subscriber | 新增 `team.subscriber.ts` |

**结论：现有代码完全没有 team 表的读写路径，新模块可干净上线，无需兼容旧调用。**

### 1.3 role_instances.team_id 的含义

`role_instances.team_id`（TEXT，无外键）是 instance 上的 denormalized 列，供 roster `scope=team` 过滤用。**保留**这一列，由 team 模块在 `addMember` / `removeMember` 时同步维护（见 §4.1 备注）。

---

## 2. 新 schema 设计

### 2.1 `teams.sql`（改后）

```sql
-- ============================================================
-- teams —— 团队
-- ============================================================
-- team 只管"谁和谁是一个组"的关系，不绑 project。
-- leader 调 request_member 时由业务层自动创建；一个 leader 实例对应一个 active team。
CREATE TABLE IF NOT EXISTS teams (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  leader_instance_id TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  description        TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK(status IN ('active','disbanded')),
  created_at         TEXT NOT NULL,
  disbanded_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_teams_leader ON teams(leader_instance_id);
CREATE INDEX IF NOT EXISTS idx_teams_status ON teams(status);
-- 一个 leader 同时只能有一个 active team（软约束，由 DAO 层 create 时先查 findActiveByLeader 校验）。
```

变更点：
1. 删除 `project_id` 列和 `idx_teams_project` 索引。
2. `leader_instance_id` 外键加 `ON DELETE CASCADE` — leader 被删，team 直接消失（简化清理）。业务层"空了 disband"的行为走 subscriber。

### 2.2 `team_members.sql`（改后）

```sql
-- ============================================================
-- team_members —— 团队成员关系（当前成员快照）
-- ============================================================
-- 一行 = 一个 instance 当前在 team 里。离开 = DELETE，不保留历史。
-- instance 被删时 CASCADE 自动移除；team disband 时走 subscriber 清空。
CREATE TABLE IF NOT EXISTS team_members (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  instance_id  TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  role_in_team TEXT,
  joined_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tm_team     ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_tm_instance ON team_members(instance_id);
-- 同一 instance 在同一 team 只能有一行
CREATE UNIQUE INDEX IF NOT EXISTS uq_tm_member ON team_members(team_id, instance_id);
```

变更点：
1. 删除 `left_at` / `leave_reason` 列。
2. `idx_tm_active` / `uq_tm_active` 带 `WHERE left_at IS NULL` 的局部索引改成普通 `uq_tm_member`。
3. `ON DELETE CASCADE` 保留（instance 删 → 自动移除关系行）。

### 2.3 与 `role_instances.team_id` 的关系

`role_instances.team_id` 是 denormalized 冗余列，由 team DAO 写入时同步维护：

- `Team.addMember(teamId, instanceId)` → `INSERT INTO team_members` + `UPDATE role_instances SET team_id=?`
- `Team.removeMember(teamId, instanceId)` → `DELETE FROM team_members` + `UPDATE role_instances SET team_id=NULL`（仅当这个 instance 当前就是这个 team 的成员）

**取舍**：保持现状（两处维护）比重构 roster scope=team 查询代价更小。唯一规则：`role_instances.team_id` 的 **唯一写入者是 team 模块**，其他地方不得 UPDATE 这一列。

---

## 3. 模块文件结构

```
packages/backend/src/team/
├── team.ts        # class Team + 全局单例 export const team
└── types.ts       # TeamRecord / TeamMemberRecord / 参数/返回类型
```

`packages/backend/src/bus/subscribers/team.subscriber.ts` — 订阅 `instance.deleted`，自动清理。

---

## 4. DAO 接口设计

### 4.1 `team/types.ts`

```ts
export type TeamStatus = 'active' | 'disbanded';

export interface TeamRecord {
  id: string;
  name: string;
  leaderInstanceId: string;
  description: string;
  status: TeamStatus;
  createdAt: string;      // ISO 8601
  disbandedAt: string | null;
}

export interface TeamMemberRecord {
  id: number;
  teamId: string;
  instanceId: string;
  roleInTeam: string | null;
  joinedAt: string;
}

export interface CreateTeamInput {
  id?: string;                      // 不传则内部 randomUUID()
  name: string;
  leaderInstanceId: string;
  description?: string;
}

export interface AddMemberInput {
  teamId: string;
  instanceId: string;
  roleInTeam?: string | null;
}
```

### 4.2 `team/team.ts` 骨架

```ts
// Team —— 团队关系表的 DAO。只管 teams + team_members 两张表。
// 不调用 domain / roster / bus；不做业务判断（"能不能加"由业务层决定）。
//
// 约定：
//   - teams.status='disbanded' 后所有查询默认不返回；显式传 includeDisbanded=true 才带回。
//   - addMember 同时维护 role_instances.team_id 冗余列（见设计文档 §2.3）。
//   - 每个方法都直接读写 DB，不缓存。
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import type {
  TeamRecord,
  TeamMemberRecord,
  CreateTeamInput,
  AddMemberInput,
} from './types.js';

interface TeamRow {
  id: string;
  name: string;
  leader_instance_id: string;
  description: string;
  status: 'active' | 'disbanded';
  created_at: string;
  disbanded_at: string | null;
}

interface TeamMemberRow {
  id: number;
  team_id: string;
  instance_id: string;
  role_in_team: string | null;
  joined_at: string;
}

const TEAM_COLS = `id, name, leader_instance_id, description, status, created_at, disbanded_at`;
const TM_COLS = `id, team_id, instance_id, role_in_team, joined_at`;

function rowToTeam(r: TeamRow): TeamRecord {
  return {
    id: r.id,
    name: r.name,
    leaderInstanceId: r.leader_instance_id,
    description: r.description,
    status: r.status,
    createdAt: r.created_at,
    disbandedAt: r.disbanded_at,
  };
}

function rowToMember(r: TeamMemberRow): TeamMemberRecord {
  return {
    id: r.id,
    teamId: r.team_id,
    instanceId: r.instance_id,
    roleInTeam: r.role_in_team,
    joinedAt: r.joined_at,
  };
}

export class Team {
  // create：插入一行 teams，返回新记录。不自动把 leader 加入 team_members。
  // 调用方想把 leader 也变成成员，得显式再调 addMember。
  create(input: CreateTeamInput): TeamRecord {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO teams (id, name, leader_instance_id, description, status, created_at, disbanded_at)
         VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
      )
      .run(id, input.name, input.leaderInstanceId, input.description ?? '', now);
    const created = this.findById(id);
    if (!created) throw new Error(`team '${id}' not found after insert`);
    return created;
  }

  // disband：软删；status='disbanded' + disbanded_at=now。
  // team_members 行由数据库的 ON DELETE CASCADE 触发？— 不，disband 不 DELETE teams 行，成员也保留。
  // 外部若需要彻底清空成员，应在 disband 后再显式 clearMembers(teamId) 或 deleteHard(teamId)。
  disband(teamId: string): void {
    const existed = this.findById(teamId);
    if (!existed) throw new Error(`team '${teamId}' not found`);
    if (existed.status === 'disbanded') return; // 幂等
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `UPDATE teams SET status='disbanded', disbanded_at=? WHERE id=? AND status='active'`,
      )
      .run(now, teamId);
  }

  // deleteHard：物理删除 teams 行。team_members 通过 ON DELETE CASCADE 自动清空。
  // 仅在需要彻底清理时用（比如测试、脏数据修复）。正常流程用 disband。
  deleteHard(teamId: string): void {
    getDb().prepare(`DELETE FROM teams WHERE id=?`).run(teamId);
  }

  // findById：按 id 查 team；不过滤 status（disbanded 也返回）。
  findById(teamId: string): TeamRecord | null {
    const row = getDb()
      .prepare(`SELECT ${TEAM_COLS} FROM teams WHERE id=?`)
      .get(teamId) as TeamRow | undefined;
    return row ? rowToTeam(row) : null;
  }

  // findActiveByLeader：按 leader instance id 查当前 active 的 team。
  // 用于创建前防重（同一 leader 不应同时拥有多个 active team）。
  findActiveByLeader(leaderInstanceId: string): TeamRecord | null {
    const row = getDb()
      .prepare(
        `SELECT ${TEAM_COLS} FROM teams WHERE leader_instance_id=? AND status='active'`,
      )
      .get(leaderInstanceId) as TeamRow | undefined;
    return row ? rowToTeam(row) : null;
  }

  // list：列出所有 team；默认只返回 active；includeDisbanded=true 全返回。
  list(includeDisbanded = false): TeamRecord[] {
    const sql = includeDisbanded
      ? `SELECT ${TEAM_COLS} FROM teams ORDER BY created_at DESC`
      : `SELECT ${TEAM_COLS} FROM teams WHERE status='active' ORDER BY created_at DESC`;
    const rows = getDb().prepare(sql).all() as TeamRow[];
    return rows.map(rowToTeam);
  }

  // addMember：把 instance 加进 team_members + 同步 role_instances.team_id。
  //   - team 不存在 / 已 disbanded → 抛错
  //   - instance 已在别的 active team → 抛错（业务规则：一个 instance 同时只能属于一个 team）
  //   - 同一 instance 已在本 team（UNIQUE 冲突）→ 幂等返回，不抛错
  addMember(input: AddMemberInput): TeamMemberRecord {
    const t = this.findById(input.teamId);
    if (!t) throw new Error(`team '${input.teamId}' not found`);
    if (t.status !== 'active') throw new Error(`team '${input.teamId}' is disbanded`);

    // 跨 team 互斥检查（轻量业务约束；若未来允许多 team 成员可去掉）。
    const other = this.findTeamIdByInstance(input.instanceId);
    if (other && other !== input.teamId) {
      throw new Error(
        `instance '${input.instanceId}' already in team '${other}'`,
      );
    }

    const now = new Date().toISOString();
    const db = getDb();
    // 幂等：存在同 (team_id, instance_id) 直接返回既有行
    const existed = db
      .prepare(`SELECT ${TM_COLS} FROM team_members WHERE team_id=? AND instance_id=?`)
      .get(input.teamId, input.instanceId) as TeamMemberRow | undefined;
    if (existed) return rowToMember(existed);

    db.prepare(
      `INSERT INTO team_members (team_id, instance_id, role_in_team, joined_at)
       VALUES (?, ?, ?, ?)`,
    ).run(input.teamId, input.instanceId, input.roleInTeam ?? null, now);

    // 同步 role_instances.team_id（denormalized 冗余列，由 team 模块独占写入）
    db.prepare(`UPDATE role_instances SET team_id=? WHERE id=?`)
      .run(input.teamId, input.instanceId);

    const row = db
      .prepare(`SELECT ${TM_COLS} FROM team_members WHERE team_id=? AND instance_id=?`)
      .get(input.teamId, input.instanceId) as TeamMemberRow;
    return rowToMember(row);
  }

  // removeMember：从 team_members 删一行 + 清 role_instances.team_id。
  // 不存在是幂等 no-op；不抛错（下游 subscriber 容错更简单）。
  removeMember(teamId: string, instanceId: string): void {
    const db = getDb();
    const res = db
      .prepare(`DELETE FROM team_members WHERE team_id=? AND instance_id=?`)
      .run(teamId, instanceId);
    if ((res.changes as number) > 0) {
      // 只在真的删到了才清 denormalized 列；若 instance 已经不在这个 team 则不动。
      db.prepare(`UPDATE role_instances SET team_id=NULL WHERE id=? AND team_id=?`)
        .run(instanceId, teamId);
    }
  }

  // listMembers：返回 team 的所有成员行。
  listMembers(teamId: string): TeamMemberRecord[] {
    const rows = getDb()
      .prepare(`SELECT ${TM_COLS} FROM team_members WHERE team_id=? ORDER BY joined_at ASC`)
      .all(teamId) as TeamMemberRow[];
    return rows.map(rowToMember);
  }

  // countMembers：返回 team 当前成员数。供 subscriber 判空用，走 COUNT 比 listMembers 轻。
  countMembers(teamId: string): number {
    const row = getDb()
      .prepare(`SELECT COUNT(*) as c FROM team_members WHERE team_id=?`)
      .get(teamId) as { c: number };
    return row.c;
  }

  // findByInstance：给 instance 反查它在哪个 team（最多一个，因为 addMember 约束互斥）。
  findByInstance(instanceId: string): TeamRecord | null {
    const row = getDb()
      .prepare(
        `SELECT ${TEAM_COLS.split(', ').map((c) => `t.${c}`).join(', ')}
         FROM teams t
         INNER JOIN team_members tm ON tm.team_id=t.id
         WHERE tm.instance_id=?`,
      )
      .get(instanceId) as TeamRow | undefined;
    return row ? rowToTeam(row) : null;
  }

  // findTeamIdByInstance：轻量版，只返 team_id，供 addMember 做互斥校验。
  private findTeamIdByInstance(instanceId: string): string | null {
    const row = getDb()
      .prepare(`SELECT team_id FROM team_members WHERE instance_id=?`)
      .get(instanceId) as { team_id: string } | undefined;
    return row?.team_id ?? null;
  }
}

export const team = new Team();
```

---

## 5. bus 事件设计

### 5.1 新增事件类型（`bus/types.ts`）

加到 `BusEventType` 联合：

```ts
export type BusEventType =
  | 'instance.created'
  // ...现有 15 种...
  | 'mcp.uninstalled'
  // 新增
  | 'team.created'
  | 'team.disbanded'
  | 'team.member_joined'
  | 'team.member_left';
```

接口定义：

```ts
export interface TeamCreatedEvent extends BusEventBase {
  type: 'team.created';
  teamId: string;
  name: string;
  leaderInstanceId: string;
}

export interface TeamDisbandedEvent extends BusEventBase {
  type: 'team.disbanded';
  teamId: string;
  reason: 'manual' | 'empty' | 'leader_gone';
}

export interface TeamMemberJoinedEvent extends BusEventBase {
  type: 'team.member_joined';
  teamId: string;
  instanceId: string;
  roleInTeam: string | null;
}

export interface TeamMemberLeftEvent extends BusEventBase {
  type: 'team.member_left';
  teamId: string;
  instanceId: string;
  reason: 'manual' | 'instance_deleted';
}
```

`BusEvent` 联合追加这 4 个接口。

### 5.2 `team.subscriber.ts`

职责：订阅 `instance.deleted` → 清除 instance 的 team 成员关系；team 空了自动 disband。**team.created / disbanded / member_joined / member_left 四类事件由 HTTP handler 直接 emit，subscriber 不自产**。

```ts
// Team subscriber —— 维护 team 的一致性：
//   - instance.deleted → removeMember + 判空 disband
// CASCADE 会自动 DELETE team_members 行，但不会更新 role_instances.team_id
// （因为 instance 已经被删了，这一列本身也被带走），所以判空 / disband 仍需 subscriber 做。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../events.js';
import { team } from '../../team/team.js';
import { makeBase } from '../helpers.js';

export function subscribeTeam(eventBus: EventBus = defaultBus): Subscription {
  const sub = new Subscription();

  sub.add(
    eventBus.on('instance.deleted').subscribe((e) => {
      try {
        // 1. 查 instance 原本所在的 team（CASCADE 还没跑之前业务上是这样；
        //    若 CASCADE 已触发，这里会查不到，算幂等）。
        const t = team.findByInstance(e.instanceId);
        if (t) {
          team.removeMember(t.id, e.instanceId);
          eventBus.emit({
            ...makeBase('team.member_left', 'bus/team.subscriber'),
            teamId: t.id,
            instanceId: e.instanceId,
            reason: 'instance_deleted',
          });

          // 2. 如果这个 instance 是 leader，直接 disband 整个 team
          //    （leader_instance_id 上的 ON DELETE CASCADE 会物理删 team 行，
          //     但我们仍 emit 事件让上层知道）
          if (t.leaderInstanceId === e.instanceId) {
            // CASCADE 可能已经把 teams 行删了，findById 查不到就跳过 disband
            if (team.findById(t.id)) {
              team.disband(t.id);
            }
            eventBus.emit({
              ...makeBase('team.disbanded', 'bus/team.subscriber'),
              teamId: t.id,
              reason: 'leader_gone',
            });
            return;
          }

          // 3. 空 team 自动解散
          if (team.countMembers(t.id) === 0) {
            team.disband(t.id);
            eventBus.emit({
              ...makeBase('team.disbanded', 'bus/team.subscriber'),
              teamId: t.id,
              reason: 'empty',
            });
          }
        }
      } catch (err) {
        process.stderr.write(
          `[bus/team] instance.deleted handler failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  return sub;
}
```

### 5.3 subscriber 注册

`bus/index.ts` 的 `bootSubscribers` 里加一行：

```ts
import { subscribeTeam } from './subscribers/team.subscriber.js';
// ...
masterSub.add(subscribeTeam());
```

### 5.4 事件发送点约定

| 事件 | 谁 emit | 时机 |
|------|--------|------|
| `team.created` | `api/panel/teams.ts` 的 `handleCreateTeam` | `team.create()` 返回成功后 |
| `team.disbanded` | `handleDisbandTeam` 或 `team.subscriber` | HTTP 显式 disband，或成员为空自动触发 |
| `team.member_joined` | `handleAddTeamMember` | `team.addMember()` 成功后 |
| `team.member_left` | `handleRemoveTeamMember` 或 `team.subscriber` | HTTP 显式 remove，或 instance 被删 |

**HTTP handler 负责"主动事件"，subscriber 负责"级联响应事件"。** 这与 roster 的分工一致（instance.* 是主动事件，roster.subscriber 是级联响应）。

---

## 6. HTTP API 设计

文件：`packages/backend/src/api/panel/teams.ts`
前缀：`/api/teams`

所有 handler 返回 `ApiResponse`（复用 `role-templates.ts` 导出的类型），风格完全对齐 `api/panel/roster.ts`。

### 6.1 端点列表

| Method | Path | Handler | 说明 |
|--------|------|---------|------|
| GET    | `/api/teams` | `handleListTeams` | 列出所有 team；`?includeDisbanded=1` 返回含已解散 |
| POST   | `/api/teams` | `handleCreateTeam` | 创建 team，emit `team.created` |
| GET    | `/api/teams/:id` | `handleGetTeam` | 按 id 查单条，附带 members 字段 |
| DELETE | `/api/teams/:id` | `handleDisbandTeam` | 解散（软删），emit `team.disbanded` reason=manual |
| GET    | `/api/teams/:id/members` | `handleListMembers` | 列出成员 |
| POST   | `/api/teams/:id/members` | `handleAddMember` | 加入成员，emit `team.member_joined` |
| DELETE | `/api/teams/:id/members/:instanceId` | `handleRemoveMember` | 移除成员，emit `team.member_left` reason=manual |

### 6.2 handler 签名和骨架

```ts
// packages/backend/src/api/panel/teams.ts
import { team } from '../../team/team.js';
import { bus } from '../../bus/index.js';
import { makeBase, newCorrelationId } from '../../bus/helpers.js';
import type { ApiResponse } from './role-templates.js';

const errRes = (status: number, error: string): ApiResponse => ({ status, body: { error } });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function handleListTeams(query: URLSearchParams): ApiResponse {
  const includeDisbanded = query.get('includeDisbanded') === '1';
  return { status: 200, body: team.list(includeDisbanded) };
}

export function handleCreateTeam(body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');
  const name = str(body.name);
  const leaderInstanceId = str(body.leaderInstanceId);
  if (!name || name.length > 64) return errRes(400, 'name is required (≤64 chars)');
  if (!leaderInstanceId) return errRes(400, 'leaderInstanceId is required');

  // 防重：同一 leader 不可同时有多个 active team
  if (team.findActiveByLeader(leaderInstanceId)) {
    return errRes(409, `leader '${leaderInstanceId}' already has an active team`);
  }

  try {
    const created = team.create({
      name,
      leaderInstanceId,
      description: str(body.description) ?? '',
    });
    bus.emit({
      ...makeBase('team.created', 'api/panel/teams', newCorrelationId()),
      teamId: created.id,
      name: created.name,
      leaderInstanceId: created.leaderInstanceId,
    });
    return { status: 201, body: created };
  } catch (e) {
    return errRes(400, (e as Error).message);
  }
}

export function handleGetTeam(teamId: string): ApiResponse {
  const t = team.findById(teamId);
  if (!t) return errRes(404, `team '${teamId}' not found`);
  const members = team.listMembers(teamId);
  return { status: 200, body: { ...t, members } };
}

export function handleDisbandTeam(teamId: string): ApiResponse {
  const t = team.findById(teamId);
  if (!t) return errRes(404, `team '${teamId}' not found`);
  if (t.status === 'disbanded') return errRes(409, `team '${teamId}' already disbanded`);
  team.disband(teamId);
  bus.emit({
    ...makeBase('team.disbanded', 'api/panel/teams'),
    teamId,
    reason: 'manual',
  });
  return { status: 204, body: null };
}

export function handleListMembers(teamId: string): ApiResponse {
  const t = team.findById(teamId);
  if (!t) return errRes(404, `team '${teamId}' not found`);
  return { status: 200, body: team.listMembers(teamId) };
}

export function handleAddMember(teamId: string, body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');
  const instanceId = str(body.instanceId);
  if (!instanceId) return errRes(400, 'instanceId is required');
  const roleInTeam = 'roleInTeam' in body ? str(body.roleInTeam) : null;

  try {
    const rec = team.addMember({ teamId, instanceId, roleInTeam });
    bus.emit({
      ...makeBase('team.member_joined', 'api/panel/teams'),
      teamId,
      instanceId,
      roleInTeam,
    });
    return { status: 201, body: rec };
  } catch (e) {
    return errRes(400, (e as Error).message);
  }
}

export function handleRemoveMember(teamId: string, instanceId: string): ApiResponse {
  const t = team.findById(teamId);
  if (!t) return errRes(404, `team '${teamId}' not found`);
  team.removeMember(teamId, instanceId);
  bus.emit({
    ...makeBase('team.member_left', 'api/panel/teams'),
    teamId,
    instanceId,
    reason: 'manual',
  });
  return { status: 204, body: null };
}
```

### 6.3 `server.ts` 路由接入

在 `server.ts` 加：

```ts
import {
  handleListTeams,
  handleCreateTeam,
  handleGetTeam,
  handleDisbandTeam,
  handleListMembers,
  handleAddMember,
  handleRemoveMember,
} from './api/panel/teams.js';

const TEAMS_PREFIX = '/api/teams';

// route() 函数内：
if (pathname === TEAMS_PREFIX) {
  if (method === 'GET') return handleListTeams(query);
  if (method === 'POST') {
    const body = await readBody(req);
    return handleCreateTeam(body);
  }
  return { status: 404, body: { error: 'not found' } };
}

if (pathname.startsWith(TEAMS_PREFIX + '/')) {
  const rest = pathname.slice(TEAMS_PREFIX.length + 1);
  const parts = rest.split('/');
  // /api/teams/:id
  if (parts.length === 1 && parts[0]) {
    if (method === 'GET') return handleGetTeam(parts[0]);
    if (method === 'DELETE') return handleDisbandTeam(parts[0]);
    return { status: 404, body: { error: 'not found' } };
  }
  // /api/teams/:id/members
  if (parts.length === 2 && parts[0] && parts[1] === 'members') {
    if (method === 'GET') return handleListMembers(parts[0]);
    if (method === 'POST') {
      const body = await readBody(req);
      return handleAddMember(parts[0], body);
    }
    return { status: 404, body: { error: 'not found' } };
  }
  // /api/teams/:id/members/:instanceId
  if (parts.length === 3 && parts[0] && parts[1] === 'members' && parts[2]) {
    if (method === 'DELETE') return handleRemoveMember(parts[0], parts[2]);
    return { status: 404, body: { error: 'not found' } };
  }
  return { status: 404, body: { error: 'not found' } };
}
```

推荐放在 ROSTER 路由之后、MCP Store 之前，保持字母顺序可读。

---

## 7. 迁移计划

### 7.1 需要新建的文件

| 路径 | 内容 |
|------|------|
| `packages/backend/src/team/types.ts` | 类型定义（§4.1） |
| `packages/backend/src/team/team.ts` | DAO 实现（§4.2） |
| `packages/backend/src/bus/subscribers/team.subscriber.ts` | subscriber（§5.2） |
| `packages/backend/src/api/panel/teams.ts` | HTTP handler（§6.2） |
| `packages/backend/src/__tests__/team.test.ts` | DAO 单测（见 §7.4） |
| `packages/backend/src/__tests__/team.subscriber.test.ts` | subscriber 集成测 |
| `packages/backend/src/__tests__/api/teams.test.ts` | HTTP handler 单测 |

### 7.2 需要修改的文件

| 路径 | 改动 |
|------|------|
| `packages/backend/src/db/schemas/teams.sql` | 删 `project_id` 列 + 索引；`leader_instance_id` 加 `ON DELETE CASCADE` |
| `packages/backend/src/db/schemas/team_members.sql` | 删 `left_at` / `leave_reason`；改索引/唯一约束 |
| `packages/backend/src/bus/types.ts` | 加 4 个事件类型 + interface |
| `packages/backend/src/bus/events.ts` | 在 `export type` 列表加新事件 interface 的 re-export |
| `packages/backend/src/bus/index.ts` | `bootSubscribers` 调 `subscribeTeam()` |
| `packages/backend/src/server.ts` | 挂 `/api/teams` 路由（§6.3） |

### 7.3 DB 兼容性

当前 `db/connection.ts` 的 `applySchemas()` 每次启动都执行所有 `CREATE TABLE IF NOT EXISTS`，**对于已有表结构变更无效**（IF NOT EXISTS 不会 ALTER 已存在的表）。

两种处理：

**方案 A（推荐，现阶段可用）**：直接删本地 DB `~/.claude/team-hub/v2.db` 重建。因为当前 schema_version=1，还没真正上线，项目 V2 阶段可以 break。

**方案 B（将来 Phase 正式化时用）**：加 migration 体系。`db/connection.ts` 的 `SCHEMA_VERSION` 升到 2，并在 `applySchemas()` 里基于 `schema_version` 表判断是否跑 `ALTER TABLE ... DROP COLUMN` / `DROP INDEX`。本次 team 模块不引入 migration 框架，但要在 PR description 里明示"本地 DB 需重建"。

### 7.4 测试清单

#### DAO 单测（`team.test.ts`）

- `create` 返回完整记录，`createdAt` 为 ISO
- `create` 同 leader 连续两次 → 第二次应靠 `handleCreateTeam` 防重（DAO 层本身允许，保持原子性）
- `disband` 后 `status='disbanded'`，`disbandedAt` 有值
- `disband` 幂等（disband 已 disbanded 的 team 不抛错）
- `addMember` 成功后 `role_instances.team_id` 被同步
- `addMember` 重复同 instance 幂等
- `addMember` 同 instance 已在其他 active team → 抛错
- `addMember` team 不存在 / disbanded → 抛错
- `removeMember` 成功清 `role_instances.team_id`
- `removeMember` 不存在的成员 → no-op
- `removeMember` 不应清掉 instance 已被 re-assigned 后的 team_id（`WHERE id=? AND team_id=?` 的双条件）
- `listMembers` 按 `joined_at` 升序
- `countMembers` 数字正确
- `findByInstance` / `findActiveByLeader` 的 happy path + miss

#### subscriber 集成测（`team.subscriber.test.ts`）

按 mnemo/125 约定：独立 `EventBus` + `TEAM_HUB_V2_DB=:memory:`。

- 删成员 instance → team_members 自动少一行 + emit `team.member_left`（reason=instance_deleted）
- 删最后一个非 leader 成员 → team disband + emit `team.disbanded` reason=empty
- 删 leader instance → team CASCADE 消失 + emit `team.disbanded` reason=leader_gone
- subscriber 抛错不影响其他 subscriber（验证 try-catch 兜底）

#### HTTP 测（`api/teams.test.ts`）

- `POST /api/teams` 校验 name/leaderInstanceId
- `POST /api/teams` 同 leader 409
- `GET /api/teams` 默认不含 disbanded
- `GET /api/teams?includeDisbanded=1` 含全部
- `GET /api/teams/:id` 返回 members 字段
- `DELETE /api/teams/:id` → 204 + emit `team.disbanded` reason=manual
- `POST /api/teams/:id/members` + `DELETE /api/teams/:id/members/:instanceId` happy path
- 错误码覆盖：team 不存在 404，body 非法 400

---

## 8. 与 roster 的边界对照

| 方面 | roster | team |
|------|--------|------|
| 核心表 | `role_instances` | `teams` + `team_members` |
| 管什么 | 当前活跃成员的**状态**（PENDING/ACTIVE/PENDING_OFFLINE + alias + task） | 成员之间的**组织关系**（谁和谁一组、谁是 leader） |
| 写入触发 | `instance.created/activated/offline_requested/deleted` | `team.created/disbanded/member_joined/member_left` + 响应 `instance.deleted` |
| 是否做业务判断 | 否，纯 DAO | 否，纯 DAO。addMember 的"跨 team 互斥"是**数据一致性约束**，不是业务策略 |
| scope 语义 | scope=team 的过滤通过 `role_instances.team_id` 实现 | 提供 `role_instances.team_id` 的唯一写入路径 |
| 缓存 | 无 | 无 |

**关键不变量**：`role_instances.team_id` 的真相由 team 模块维护。roster 读这一列时，隐式依赖 team 模块保证一致性。

---

## 9. 开放问题 / 将来扩展

1. **leader 能不能既是成员又是 leader？** 本方案默认 create 时**不自动**把 leader 加入 team_members。业务层（如"Leader 调 request_member 时自动创建 team"）如果需要，应显式再调 addMember。保持原子模块不做这个决定。
2. **allow instance 同时属于多个 team？** 当前 addMember 互斥校验。若未来取消，删 `addMember` 里的 `other && other !== teamId` 分支 + `role_instances.team_id` 改为"主 team"语义。
3. **历史追踪**（left_at / leave_reason）—— 本期用户明确说砍，若将来需要审计，可新建 `team_member_events` 表而不是往 `team_members` 加列。
4. **project 与 team 的联动**—— 由将来的 project 模块通过订阅 `team.*` 事件实现，team 模块本身不感知 project。

---

## 10. 实施顺序建议

1. 改 schema（`teams.sql` + `team_members.sql`），提醒删本地 v2.db。
2. 加 bus 事件类型（`types.ts` + `events.ts` re-export）。
3. 写 `team/types.ts` + `team/team.ts`，配单测跑通。
4. 写 `bus/subscribers/team.subscriber.ts`，配集成测跑通。
5. `bus/index.ts` 注册 subscriber。
6. 写 `api/panel/teams.ts`，配 HTTP 测跑通。
7. `server.ts` 挂路由，跑整体 bun test。
8. 更新 `docs/PROGRESS.md` — Team 项标"完成"。
