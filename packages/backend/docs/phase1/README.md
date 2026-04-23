# V2 — 角色模板 + 角色实例 + 完整业务域

## 目标

从零搭建 mteam V2 服务端。V2 围绕**角色实例**展开，状态机驱动生命周期，
Team / Project / Messages 是实例的协作维度。

本文档是 V2 **完整数据库设计**，覆盖所有业务需求。

## 核心概念

| 概念 | 说明 |
|------|------|
| **RoleTemplate（角色模板）** | 薄配置：角色身份 + 可用 MCP。持久化、可复用。 |
| **RoleInstance（角色实例）** | 运行时对象。每次工作创建新实例，状态机驱动，不可复活。 |
| **Team（团队）** | leader 调 `request_member` 时自动创建，以 leader 实例为核心。 |
| **Project（项目）** | leader 创建，活跃成员自动加入。带规则、进度、经验。 |
| **Message（消息）** | 实例间点对点通信，支持未读标记。 |
| **RoleStateEvent（状态事件）** | 状态变更审计日志，每次 transition 原子写入。 |
| **Governance（治理）** | 团队级规则 KV 存储。 |

## 设计原则

- **不设限**：同一 `member_name` 可有多个活跃实例。
- **无锁 / 无预约码 / 无 nonce / 无心跳 / 无记忆**：这些旧概念全部移除。
  记忆由 mnemo 负责；进程探活靠 session_pid。
- **session_id**（Hub 分配的会话 UUID，业务标识）和 **session_pid**（CLI 进程 PID，进程探活用）都挂在 `role_instances` 上。
- **表名不加 `_p1` 后缀**，直接用正式名。
- **全新设计**，不考虑旧表迁移。

## ER 关系图（文字版）

```
role_templates (1) ────< (N) role_instances
                                    │
                                    ├──(1:1 as leader)── teams ───< team_members >─── role_instances
                                    │
                                    ├──(N:M via project_members)── projects
                                    │                                    │
                                    │                                    └───< project_rules
                                    │
                                    ├──< role_state_events
                                    │
                                    └──< messages (from / to)
                                              │
                                              └── (self) reply_to

governance (KV，独立表，引用 role_instances 记录 updated_by)
```

关键关系：
- `role_instances.template_name` → `role_templates.name`（N:1）
- `role_instances.team_id` → `teams.id`（N:1，当前所属）
- `role_instances.project_id` → `projects.id`（N:1，当前所属）
- `teams.leader_instance_id` → `role_instances.id`（1:1，leader）
- `team_members` 是 `teams` × `role_instances` 的历史记录（含 joined_at / left_at）
- `project_members` 同上
- `messages.from_instance_id` / `messages.to_instance_id` → `role_instances.id`
- `role_state_events.instance_id` → `role_instances.id`（1:N，审计）

---

## 数据库 Schema

### 1. role_templates —— 角色模板

```sql
CREATE TABLE role_templates (
  name             TEXT PRIMARY KEY,
  role             TEXT NOT NULL,
  description      TEXT,
  persona          TEXT,
  available_mcps   TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_rt_role ON role_templates(role);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| name | TEXT PK | 模板唯一名，如"刺猬"、"老锤" |
| role | TEXT | 职业标签：dev / qa / leader / architect / product / ux |
| description | TEXT | 岗位描述 |
| persona | TEXT | 身份提示词，实例化时注入 agent |
| available_mcps | TEXT | JSON 数组，如 `["mteam","mnemo"]` |
| created_at | TEXT | ISO 时间 |
| updated_at | TEXT | ISO 时间，修改模板时更新 |

---

### 2. role_instances —— 角色实例（核心）

```sql
CREATE TABLE role_instances (
  id                TEXT PRIMARY KEY,
  template_name     TEXT NOT NULL REFERENCES role_templates(name),
  member_name       TEXT NOT NULL,
  alias             TEXT,
  is_leader         INTEGER NOT NULL DEFAULT 0 CHECK(is_leader IN (0,1)),
  team_id           TEXT REFERENCES teams(id) ON DELETE SET NULL,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'STARTING'
                    CHECK(status IN ('STARTING','ACTIVATING','WORKING','PENDING_DEPARTURE','OFFLINE')),
  status_since      TEXT NOT NULL,
  session_id        TEXT UNIQUE,
  session_pid       INTEGER,
  leader_name       TEXT,
  task              TEXT,
  created_at        TEXT NOT NULL,
  destroyed_at      TEXT,
  destroy_reason    TEXT
);
CREATE INDEX idx_ri_member    ON role_instances(member_name);
CREATE INDEX idx_ri_alias     ON role_instances(alias);
CREATE INDEX idx_ri_template  ON role_instances(template_name);
CREATE INDEX idx_ri_team      ON role_instances(team_id);
CREATE INDEX idx_ri_project   ON role_instances(project_id);
CREATE INDEX idx_ri_status    ON role_instances(status);
CREATE INDEX idx_ri_session   ON role_instances(session_id);
CREATE INDEX idx_ri_pid       ON role_instances(session_pid);
CREATE INDEX idx_ri_leader    ON role_instances(leader_name);
CREATE INDEX idx_ri_active
  ON role_instances(member_name, status)
  WHERE destroyed_at IS NULL;
```

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID，实例唯一标识 |
| template_name | TEXT FK | 指向 role_templates.name |
| member_name | TEXT | 实例名，可与模板名不同 |
| alias | TEXT | 备注名（可重名）。INSERT 时若未提供，应用层用 `member_name` 兜底写入。lookup / send_msg 的模糊匹配默认走 `COALESCE(alias, member_name)`，保证备注名和原名都能被搜到 |
| is_leader | INTEGER | 0=成员，1=leader |
| team_id | TEXT FK | 所属 team，可为空 |
| project_id | TEXT FK | 所属 project，可为空 |
| status | TEXT | 状态机当前状态 |
| status_since | TEXT | 上次状态变更时间 |
| session_id | TEXT UNIQUE | Hub 分配的会话 UUID（业务标识） |
| session_pid | INTEGER | CLI 进程 PID（进程探活用） |
| leader_name | TEXT | 该实例的 leader 是谁（冗余字段，便于查询） |
| task | TEXT | 当前任务描述 |
| created_at | TEXT | 实例创建时间 |
| destroyed_at | TEXT | 销毁时间（非空=终态） |
| destroy_reason | TEXT | 销毁原因 |

**不设限**：同一 member_name 可以有多个活跃实例。
**活跃定义**：`destroyed_at IS NULL AND status != 'OFFLINE'`。
**alias 生命周期**：行物理删除时 alias 随之消失（无独立存储），与 member_name 同进退。不做唯一性约束，允许重名，消歧由上层 lookup 的 `match: "multiple"` 分支处理。

---

### 3. role_state_events —— 状态变更审计日志

```sql
CREATE TABLE role_state_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id    TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  from_state     TEXT,
  to_state       TEXT NOT NULL,
  trigger_event  TEXT NOT NULL,
  actor          TEXT,
  reason         TEXT,
  at             TEXT NOT NULL
);
CREATE INDEX idx_rse_instance ON role_state_events(instance_id, id DESC);
CREATE INDEX idx_rse_at       ON role_state_events(at DESC);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增主键 |
| instance_id | TEXT FK | 指向 role_instances.id |
| from_state | TEXT | 前一状态（首次创建为 NULL） |
| to_state | TEXT | 新状态 |
| trigger_event | TEXT | 触发事件名（start_activate / finish_activate / ...） |
| actor | TEXT | 触发者 member_name 或系统 |
| reason | TEXT | 变更原因（如 departure requirement） |
| at | TEXT | ISO 时间 |

每次 transition 原子写入：`UPDATE role_instances + INSERT role_state_events`（同事务）。

---

### 4. teams —— 团队

```sql
CREATE TABLE teams (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  leader_instance_id TEXT NOT NULL REFERENCES role_instances(id),
  project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
  description        TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK(status IN ('active','disbanded')),
  created_at         TEXT NOT NULL,
  disbanded_at       TEXT
);
CREATE INDEX idx_teams_leader   ON teams(leader_instance_id);
CREATE INDEX idx_teams_project  ON teams(project_id);
CREATE INDEX idx_teams_status   ON teams(status);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| name | TEXT | Team 名，由 leader 指定或系统生成 |
| leader_instance_id | TEXT FK | Team 的 leader 实例 |
| project_id | TEXT FK | Team 所属项目（可空，非项目团队） |
| description | TEXT | Team 简介 |
| status | TEXT | active / disbanded |
| created_at | TEXT | 创建时间（leader 首次 request_member 时） |
| disbanded_at | TEXT | 解散时间 |

**自动创建**：leader 实例首次调用 `request_member` 时，若尚无 team 则自动创建。

---

### 5. team_members —— 实例加入 team 的历史记录

```sql
CREATE TABLE team_members (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  instance_id      TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  role_in_team     TEXT,
  joined_at        TEXT NOT NULL,
  left_at          TEXT,
  leave_reason     TEXT
);
CREATE INDEX idx_tm_team       ON team_members(team_id);
CREATE INDEX idx_tm_instance   ON team_members(instance_id);
CREATE INDEX idx_tm_active
  ON team_members(team_id, instance_id)
  WHERE left_at IS NULL;
CREATE UNIQUE INDEX uq_tm_active
  ON team_members(team_id, instance_id)
  WHERE left_at IS NULL;
```

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 |
| team_id | TEXT FK | 团队 |
| instance_id | TEXT FK | 实例 |
| role_in_team | TEXT | 在团队中的角色（dev / qa / reviewer...，自由文本） |
| joined_at | TEXT | 加入时间 |
| left_at | TEXT | 离开时间（NULL=仍在） |
| leave_reason | TEXT | 离开原因 |

一条记录表示"一次参与"。同一实例在同一 team 可重复加入/离开；
唯一索引 `uq_tm_active` 确保当前仅有一条活跃记录。

---

### 6. projects —— 项目

```sql
CREATE TABLE projects (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT 'planning'
                         CHECK(status IN ('planning','designing','developing',
                                          'testing','bugfixing','done','abandoned')),
  progress               INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  experience             TEXT NOT NULL DEFAULT '',
  created_by_instance_id TEXT REFERENCES role_instances(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX idx_projects_status_updated ON projects(status, updated_at DESC);
CREATE INDEX idx_projects_created_by     ON projects(created_by_instance_id);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| name | TEXT | 项目名 |
| description | TEXT | 项目描述 |
| status | TEXT | planning / designing / developing / testing / bugfixing / done / abandoned |
| progress | INTEGER | 0~100 |
| experience | TEXT | 项目经验沉淀（长文本） |
| created_by_instance_id | TEXT FK | 创建者实例 |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 最后更新时间 |

---

### 7. project_members —— 实例加入 project 的历史记录

```sql
CREATE TABLE project_members (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_id      TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  joined_at        TEXT NOT NULL,
  left_at          TEXT,
  leave_reason     TEXT
);
CREATE INDEX idx_pm_project    ON project_members(project_id);
CREATE INDEX idx_pm_instance   ON project_members(instance_id);
CREATE UNIQUE INDEX uq_pm_active
  ON project_members(project_id, instance_id)
  WHERE left_at IS NULL;
```

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 |
| project_id | TEXT FK | 项目 |
| instance_id | TEXT FK | 实例 |
| joined_at | TEXT | 加入时间 |
| left_at | TEXT | 离开时间（NULL=仍在） |
| leave_reason | TEXT | 离开原因 |

**自动加入**：实例从 STARTING → WORKING 时，若 `role_instances.project_id` 非空，
则自动 insert 一条 `project_members` 记录。

---

### 8. project_rules —— 项目规则

```sql
CREATE TABLE project_rules (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind                   TEXT NOT NULL CHECK(kind IN ('forbidden','rules')),
  seq                    INTEGER NOT NULL,
  content                TEXT NOT NULL,
  created_by_instance_id TEXT REFERENCES role_instances(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_pr_project_kind_seq
  ON project_rules(project_id, kind, seq);
CREATE INDEX idx_pr_project    ON project_rules(project_id);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 |
| project_id | TEXT FK | 项目 |
| kind | TEXT | forbidden（绝对禁止）/ rules（必须遵循） |
| seq | INTEGER | 在同一 kind 下的顺序（1,2,3...） |
| content | TEXT | 规则正文 |
| created_by_instance_id | TEXT FK | 添加者实例 |
| created_at | TEXT | 添加时间 |

`(project_id, kind, seq)` 联合唯一。activate 时将 forbidden / rules 打包注入成员。

---

### 9. messages —— 实例间消息

```sql
CREATE TABLE messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  from_instance_id TEXT REFERENCES role_instances(id) ON DELETE SET NULL,
  to_instance_id   TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  team_id          TEXT REFERENCES teams(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL DEFAULT 'chat'
                   CHECK(kind IN ('chat','task','broadcast','system')),
  summary          TEXT NOT NULL DEFAULT '',
  content          TEXT NOT NULL,
  sent_at          TEXT NOT NULL,
  read_at          TEXT,
  reply_to_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL
);
CREATE INDEX idx_msg_to_unread
  ON messages(to_instance_id, sent_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX idx_msg_to        ON messages(to_instance_id, sent_at DESC);
CREATE INDEX idx_msg_from      ON messages(from_instance_id, sent_at DESC);
CREATE INDEX idx_msg_team      ON messages(team_id, sent_at DESC);
CREATE INDEX idx_msg_reply     ON messages(reply_to_id);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 |
| from_instance_id | TEXT FK | 发送者实例（NULL=系统消息） |
| to_instance_id | TEXT FK | 接收者实例 |
| team_id | TEXT FK | 关联 team（便于按团队查询） |
| kind | TEXT | chat / task / broadcast / system |
| summary | TEXT | 摘要（Panel 列表展示） |
| content | TEXT | 正文（Markdown 或纯文本） |
| sent_at | TEXT | 发送时间 |
| read_at | TEXT | 读取时间（NULL=未读） |
| reply_to_id | INTEGER | 回复关联的消息 id |

广播：`kind='broadcast'` 时由上层遍历 team_members 展开为多条点对点消息。

---

### 10. governance —— 团队治理规则（KV 存储）

```sql
CREATE TABLE governance (
  key                    TEXT PRIMARY KEY,
  value_json             TEXT NOT NULL,
  updated_by_instance_id TEXT REFERENCES role_instances(id) ON DELETE SET NULL,
  updated_at             TEXT NOT NULL
);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| key | TEXT PK | 规则键，如 `team_rules`、`default_persona` |
| value_json | TEXT | JSON 序列化的规则内容 |
| updated_by_instance_id | TEXT FK | 最后修改者 |
| updated_at | TEXT | 最后修改时间 |

简单 KV，具体结构由 value_json 自描述。activate 时整块注入。

---

### 11. schema_version —— 版本记录

```sql
CREATE TABLE schema_version (
  version          INTEGER PRIMARY KEY,
  applied_at       TEXT NOT NULL,
  note             TEXT
);
```

---

## 状态机

```
STARTING → ACTIVATING → WORKING ⇄ PENDING_DEPARTURE
                          ↓              ↓
                       OFFLINE        OFFLINE
```

OFFLINE 是终态，`destroyed_at` 非空，实例不可复活。

### 转换规则

| 事件 | from | to |
|------|------|-----|
| start_activate    | STARTING          | ACTIVATING |
| finish_activate   | ACTIVATING        | WORKING |
| request_departure | WORKING           | PENDING_DEPARTURE |
| cancel_departure  | PENDING_DEPARTURE | WORKING |
| clock_out         | WORKING / PENDING_DEPARTURE | OFFLINE |
| deactivate        | WORKING           | OFFLINE |
| crash             | 任意非 OFFLINE     | OFFLINE |

### 事务保证

每次 transition 原子写入：
```sql
BEGIN;
  UPDATE role_instances SET status=?, status_since=?, destroyed_at=?, destroy_reason=? WHERE id=?;
  INSERT INTO role_state_events (instance_id, from_state, to_state, trigger_event, actor, reason, at) VALUES (...);
COMMIT;
```

---

## 自动化规则（业务侧应实现）

| 触发 | 动作 |
|------|------|
| leader 实例首次 request_member | 若该 leader 尚无 team → INSERT teams，leader_instance_id 指向自己 |
| 新实例 STARTING → WORKING | 若有 project_id → INSERT project_members（若当前无活跃记录） |
| 新实例加入 team | INSERT team_members |
| 实例 → OFFLINE | UPDATE team_members SET left_at=NOW() WHERE left_at IS NULL；UPDATE project_members 同理 |
| leader 实例 → OFFLINE | 可选：UPDATE teams SET status='disbanded' |
| 实例销毁 | destroyed_at 非空、status='OFFLINE'，不物理删除 |

---

## V2 文件清单

```
v2/
├── docs/phase1/README.md     # 本文档（完整数据库设计）
├── db-schema.sql             # 纯 SQL 文件，可直接执行
├── db.ts                     # SQLite 初始化 + schema apply
├── state-machine.ts          # 状态枚举 + 转换规则 + resolveTransition()
├── role-template.ts          # RoleTemplate CRUD
├── role-instance.ts          # RoleInstance（create/transition/destroy）
├── team.ts                   # Team + TeamMember
├── project.ts                # Project + ProjectMember + ProjectRule
├── message.ts                # Message（send / read / list）
├── governance.ts             # Governance KV
├── events.ts                 # EventEmitter（状态变更事件，SSE 预留）
└── index.ts                  # 统一导出
```

## 不做（明确边界）

- HTTP server / 路由
- MCP 工具接入
- Panel SSE
- Reaper（进程探活）
- 记忆（mnemo 管）
- 锁 / 预约码 / 心跳 / nonce

---

## 验收标准

```ts
// 1. 建模板
const tpl = RoleTemplate.create({ name: '刺猬', role: 'qa', persona: '你是测试...' });

// 2. 创建 leader 实例
const leader = RoleInstance.create({ template_name: 'leader-tpl', member_name: 'lead-01', is_leader: 1 });
leader.transition('start_activate');
leader.transition('finish_activate');

// 3. leader 建 team（request_member 触发）
const team = Team.ensureForLeader(leader.id, { name: 'squad-A' });

// 4. 派成员
const member = RoleInstance.create({ template_name: '刺猬', member_name: '刺猬-01', team_id: team.id, leader_name: leader.member_name });
member.transition('start_activate');
member.transition('finish_activate');  // 自动加入 team_members / project_members

// 5. 建 project + 规则
const proj = Project.create({ name: 'mteam', created_by_instance_id: leader.id });
ProjectRule.add(proj.id, 'forbidden', 1, '不准 mock 测试');
ProjectRule.add(proj.id, 'rules', 1, '新模块必须带单测');

// 6. 发消息
Message.send({ from: leader.id, to: member.id, team_id: team.id, kind: 'task', content: '去修 bug-123' });

// 7. 成员下线
member.transition('clock_out');   // → OFFLINE；team_members / project_members 自动 left_at

// 8. 审计
// role_state_events 至少 4 条（STARTING→ACTIVATING→WORKING→OFFLINE）
```

可以 `TEAM_HUB_DB=:memory:` 跑内存库验证。
