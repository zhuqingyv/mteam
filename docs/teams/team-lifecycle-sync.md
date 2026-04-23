# Team 生命周期联动补充方案

> 补充 team-manager-design.md，聚焦 team 与 instance 之间的生命周期联动链路。
> 给实现 agent 看，读完就能动手改代码。

---

## 0. 核心原则

1. **Leader 和 team 生死绑定** — leader instance 消失 → team 必须解散 → 所有成员 instance 跟随下线。
2. **一个 leader 只能有一个 ACTIVE team** — 创建时校验，DB 层加约束。
3. **成员下线 → team 同步移除** — 无论 request_offline 还是 deleted，team 侧都要感知。
4. **级联动作不循环触发** — 用 reason 标记区分主动 vs 级联，subscriber 过滤已处理的事件。

---

## 1. 整体事件流向图

```
                          ┌─────────────────────────────────────────────────────────────┐
                          │                       HTTP API Layer                        │
                          └──────┬──────────┬──────────┬────────────┬──────────┬────────┘
                                 │          │          │            │          │
                        create   │  request │  delete  │   disband  │  remove  │
                        team     │  offline │  instance│   team     │  member  │
                                 │          │          │            │          │
                          ▼      │    ▼     │    ▼     │      ▼     │    ▼     │
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    Event Bus                                            │
│                                                                                         │
│  team.created  instance.offline_requested  instance.deleted  team.disbanded  team.member_left │
└──┬──────────────────┬──────────────────────────┬─────────────────┬───────────────┬──────┘
   │                  │                          │                 │               │
   ▼                  ▼                          ▼                 ▼               ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                              team.subscriber.ts                                          │
│                                                                                          │
│  ┌─ instance.offline_requested ──────────────────────────────────────────────┐            │
│  │  if member belongs to a team:                                             │            │
│  │    → team.removeMember() + emit team.member_left(offline_requested)       │            │
│  │  if is leader:                                                            │            │
│  │    → cascade: request_offline all ACTIVE members                          │            │
│  │    → cascade: force delete all PENDING members                            │            │
│  │    → team.disband() + emit team.disbanded(leader_gone)                    │            │
│  └───────────────────────────────────────────────────────────────────────────┘            │
│                                                                                          │
│  ┌─ instance.deleted ───────────────────────────────────────────────────────┐             │
│  │  if member belongs to a team:                                            │             │
│  │    → team.removeMember() + emit team.member_left(instance_deleted)       │             │
│  │  if is leader:                                                           │             │
│  │    → DB CASCADE deletes team row                                         │             │
│  │    → emit team.disbanded(leader_gone)                                    │             │
│  │    → cascade: delete all remaining member instances (force)              │             │
│  │  else if team empty after remove:                                        │             │
│  │    → team.disband() + emit team.disbanded(empty)                         │             │
│  └──────────────────────────────────────────────────────────────────────────┘             │
│                                                                                          │
│  ┌─ team.disbanded ─────────────────────────────────────────────────────────┐             │
│  │  list all remaining member instances in team:                            │             │
│  │    ACTIVE members → request_offline + delete                             │             │
│  │    PENDING members → force delete                                        │             │
│  │    PENDING_OFFLINE members → force delete                                │             │
│  └──────────────────────────────────────────────────────────────────────────┘             │
│                                                                                          │
│  ┌─ instance.created (teamId != null) ──────────────────────────────────────┐             │
│  │  → team.addMember() + emit team.member_joined                            │             │
│  └──────────────────────────────────────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────────────────────────────────────┘

                 ┌──────────────────────────────────────────┐
                 │           其他 subscriber 并联             │
                 │                                          │
                 │  roster.subscriber: instance.* → roster  │
                 │  pty.subscriber: instance.* → pty        │
                 │  ws.subscriber: * → WebSocket push       │
                 └──────────────────────────────────────────┘
```

### 级联链路详解

```
Case A: Leader request_offline（优雅下线）
═══════════════════════════════════════════
  API: handleRequestOffline(leaderId)
    → emit instance.offline_requested { instanceId: leaderId }
    → team.subscriber 收到:
        1. 识别 isLeader=true
        2. 遍历 team 成员:
           - ACTIVE 成员 → instance.requestOffline() + emit instance.offline_requested
           - PENDING / PENDING_OFFLINE 成员 → instance.delete() + emit instance.deleted(force=true)
        3. team.disband() + emit team.disbanded(leader_gone)
    → 每个成员的 instance.offline_requested 会被 roster.subscriber 消费（status→PENDING_OFFLINE）
    → 成员后续走正常 delete 流程（由调用方或自动清理触发）

Case B: Leader deleted（崩溃/强制删除）
═══════════════════════════════════════════
  API: handleDeleteInstance(leaderId, force=true)
    → emit instance.deleted { instanceId: leaderId, force: true }
    → DB CASCADE 删除 teams 行 + team_members 行
    → team.subscriber 收到:
        1. 识别 isLeader=true（用之前 findByInstance 快照）
        2. 遍历成员（用之前查到的成员列表快照）:
           - 所有状态的成员 → instance.delete() + emit instance.deleted(force=true)
        3. emit team.disbanded(leader_gone)（team 行已被 CASCADE 删除，仅语义事件）
    → 每个成员的 instance.deleted 被 pty/roster subscriber 消费

Case C: 手动 disband
═══════════════════════════════════════════
  API: handleDisbandTeam(teamId)
    → team.disband() + emit team.disbanded(manual)
    → team.subscriber 收到:
        1. 遍历成员:
           - ACTIVE → requestOffline + emit instance.offline_requested
           - PENDING / PENDING_OFFLINE → delete(force) + emit instance.deleted
        2. 不再重复 disband（team 已经 DISBANDED）

Case D: 成员 request_offline
═══════════════════════════════════════════
  API: handleRequestOffline(memberId)
    → emit instance.offline_requested { instanceId: memberId }
    → team.subscriber 收到:
        1. 识别 isLeader=false
        2. team.removeMember() + emit team.member_left(offline_requested)
        3. 不检查空 team — leader 还在，可以再拉人

Case E: 成员 deleted
═══════════════════════════════════════════
  (现有逻辑，不变)
```

---

## 2. 变更 Case 清单

### Case 1: 成员 instance request_offline（ACTIVE → PENDING_OFFLINE）

| 维度 | 内容 |
|------|------|
| **触发条件** | API `handleRequestOffline(memberId)` → emit `instance.offline_requested` |
| **当前行为** | `team.subscriber` **不订阅** `instance.offline_requested`。成员状态变为 PENDING_OFFLINE，但 team_members 里仍保留该行。后续 delete 时才清理。 |
| **期望行为** | `team.subscriber` 订阅 `instance.offline_requested`，立即 `removeMember` + emit `team.member_left(reason: 'offline_requested')`。如果 team 空了，自动 disband。 |
| **改动点** | `team.subscriber.ts`: 新增 `eventBus.on('instance.offline_requested').subscribe(...)` |
| **原因** | request_offline 意味着成员已批准离开，team 关系应立即解除，不应等到 delete 才清理。避免 PENDING_OFFLINE 的成员还出现在 team 成员列表中。 |

### Case 2: 成员 instance deleted

| 维度 | 内容 |
|------|------|
| **触发条件** | API `handleDeleteInstance(memberId)` → emit `instance.deleted` |
| **当前行为** | `team.subscriber` 已订阅 `instance.deleted`：removeMember + team.member_left，空 team 自动 disband。**基本正确。** |
| **期望行为** | 同当前行为。唯一补充：若 Case 1 已经在 offline_requested 时移除了成员，这里 `removeMember` 返回 false（幂等），不会重复 emit。 |
| **改动点** | 无。现有逻辑已覆盖，且 removeMember 天然幂等。 |

### Case 3: Leader instance request_offline

| 维度 | 内容 |
|------|------|
| **触发条件** | API `handleRequestOffline(leaderId)` → emit `instance.offline_requested` |
| **当前行为** | `team.subscriber` **不订阅** `instance.offline_requested`。leader 变 PENDING_OFFLINE，但 team 不受任何影响，成员继续运行。 |
| **期望行为** | `team.subscriber` 收到 `instance.offline_requested`，检测到 isLeader：<br>1. 遍历 team 所有成员（不含 leader 自身）<br>2. ACTIVE 成员 → 调 `instance.requestOffline(leaderId)` + emit `instance.offline_requested`<br>3. PENDING / PENDING_OFFLINE 成员 → 调 `instance.delete()` + emit `instance.deleted(force=true)`<br>4. `team.disband(teamId)` + emit `team.disbanded(leader_gone)` |
| **改动点** | `team.subscriber.ts`: 在新增的 `instance.offline_requested` handler 中加 leader 分支逻辑 |
| **注意** | 级联产生的 `instance.offline_requested` / `instance.deleted` 事件会再次进入 team.subscriber。需要防循环（见 §4 边界问题）。 |

### Case 4: Leader instance deleted

| 维度 | 内容 |
|------|------|
| **触发条件** | API `handleDeleteInstance(leaderId)` → emit `instance.deleted` |
| **当前行为** | `team.subscriber` 订阅 `instance.deleted`：识别 isLeader → emit `team.disbanded(leader_gone)`。**但不级联删除成员 instance**。成员 instance 的 team_members 行被 DB CASCADE 删了，但 instance 本身还活着（PTY 还在跑）。 |
| **期望行为** | 在 emit `team.disbanded` 之前/之后，**必须级联删除所有成员 instance**：<br>1. 在 `findByInstance` 之后、instance 被 CASCADE 删除之前，先查出所有成员列表<br>2. 对每个成员 instance 调 `instance.delete()` + emit `instance.deleted(force=true)`<br>3. emit `team.disbanded(leader_gone)` |
| **改动点** | `team.subscriber.ts`: 在 `instance.deleted` handler 的 isLeader 分支中，添加成员级联删除逻辑 |
| **关键时序** | leader 的 `instance.deleted` 触发时，DB CASCADE 可能已经删了 team 行和 team_members 行。所以必须在 handler 最开头用 `findByInstance` + `listMembers` 拿快照，后续操作基于快照。 |

### Case 5: 手动解散 team（API disband）

| 维度 | 内容 |
|------|------|
| **触发条件** | API `handleDisbandTeam(teamId)` → `team.disband()` + emit `team.disbanded(manual)` |
| **当前行为** | `team.subscriber` **不订阅** `team.disbanded`。disband 只修改 team 的 status 为 DISBANDED，**不影响任何成员 instance**。成员 PTY 继续跑，roster 继续在线。 |
| **期望行为** | `team.subscriber` 订阅 `team.disbanded`，级联处理所有成员：<br>1. 查 `team.listMembers(teamId)` 获取所有成员<br>2. 对每个成员 instance：<br>   - ACTIVE → `requestOffline` + emit `instance.offline_requested`<br>   - PENDING → `delete(force)` + emit `instance.deleted`<br>   - PENDING_OFFLINE → `delete(force)` + emit `instance.deleted`<br>3. leader instance 自身也按同样逻辑处理（leader 也是成员） |
| **改动点** | `team.subscriber.ts`: 新增 `eventBus.on('team.disbanded').subscribe(...)` |
| **注意** | 级联产生的 `instance.deleted` 事件会触发 team.subscriber 的 `instance.deleted` handler。由于 team 已经 DISBANDED，`findByInstance` 应该返回 null（因为成员已被 remove 或 team 已不在），天然幂等。但仍需确认不会二次 disband。 |

### Case 6: 创建 team（唯一约束）

| 维度 | 内容 |
|------|------|
| **触发条件** | API `handleCreateTeam({ leaderInstanceId })` |
| **当前行为** | **无唯一约束**。同一个 leader instance 可以创建多个 ACTIVE team。`teams` 表只有 `idx_teams_leader` 普通索引，不是唯一索引。 |
| **期望行为** | 一个 leader 同时只能有一个 ACTIVE team。创建时校验，有冲突返回 409。 |
| **改动点** | 三层防御：<br>1. **DB 层**：`teams.sql` 加 partial unique index `CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_active_leader ON teams(leader_instance_id) WHERE status='ACTIVE'`<br>2. **DAO 层**：`team.ts` 的 `create()` 方法在 INSERT 前查询 `SELECT id FROM teams WHERE leader_instance_id=? AND status='ACTIVE'`，有则抛错<br>3. **API 层**：`teams.ts` 的 `handleCreateTeam` catch 错误返回 409 |

### Case 7: 成员被 removeMember（手动踢人）

| 维度 | 内容 |
|------|------|
| **触发条件** | API `handleRemoveMember(teamId, instanceId)` |
| **当前行为** | `team.removeMember()` + emit `team.member_left(manual)`。**不影响成员 instance 本身** — instance 继续运行，PTY 继续在线。 |
| **期望行为** | 踢人后成员 instance 应该被下线：<br>1. `team.removeMember()` + emit `team.member_left(manual)`<br>2. 被踢的 instance 如果是 ACTIVE → `requestOffline` + emit `instance.offline_requested`<br>3. 被踢的 instance 如果是 PENDING → `delete(force)` + emit `instance.deleted` |
| **改动点** | 两种方案（推荐方案 A）：<br>**方案 A**：在 `team.subscriber.ts` 新增 `team.member_left` 订阅，当 reason 为 `manual` 时触发 instance 下线<br>**方案 B**：直接在 `handleRemoveMember` API handler 中加 instance 下线逻辑<br><br>方案 A 更符合现有 bus 架构（handler 发事件，subscriber 做副作用）。 |
| **注意** | `team.member_left` 的 reason 现在只有 `'manual' \| 'instance_deleted'`。需要扩展为 `'manual' \| 'instance_deleted' \| 'offline_requested'`，用于区分触发来源，避免循环。 |

---

## 3. 具体改动清单

### 3.1 team.subscriber.ts 改动

#### 新增订阅 1: `instance.offline_requested`

```typescript
eventBus.on('instance.offline_requested').subscribe((e) => {
  const t = team.findByInstance(e.instanceId);
  if (!t) return;
  const isLeader = t.leaderInstanceId === e.instanceId;

  // 无论 leader 还是成员，先从 team 移除
  const removed = team.removeMember(t.id, e.instanceId);
  if (removed) {
    eventBus.emit({
      ...makeBase('team.member_left', 'bus/team.subscriber'),
      teamId: t.id,
      instanceId: e.instanceId,
      reason: 'offline_requested',
    });
  }

  if (isLeader) {
    // leader 下线 → 级联所有成员
    const members = team.listMembers(t.id);
    for (const m of members) {
      cascadeOfflineMember(eventBus, m.instanceId, e.instanceId);
    }
    team.disband(t.id);
    eventBus.emit({
      ...makeBase('team.disbanded', 'bus/team.subscriber'),
      teamId: t.id,
      reason: 'leader_gone',
    });
  // 成员全走光不解散 — leader 还在，可以再拉人。
  // team 解散只有两种触发：leader 下线 / 手动 API disband。
});
```

#### 新增订阅 2: `team.disbanded`

```typescript
eventBus.on('team.disbanded').subscribe((e) => {
  // 只处理 manual disband（API 手动解散）
  // leader_gone / empty 的级联已由 instance.* handler 处理，不重复
  if (e.reason !== 'manual') return;

  const members = team.listMembers(e.teamId);
  for (const m of members) {
    cascadeOfflineMember(eventBus, m.instanceId, 'team-disband');
  }
});
```

#### 新增订阅 3: `team.member_left`（踢人联动）

```typescript
eventBus.on('team.member_left').subscribe((e) => {
  // 只处理手动踢人，其他 reason 的下线由上游事件已触发
  if (e.reason !== 'manual') return;
  cascadeOfflineMember(eventBus, e.instanceId, 'team-kick');
});
```

#### 修改现有: `instance.deleted` handler

在 isLeader 分支中，在 emit `team.disbanded` 之前，增加成员级联删除：

```typescript
if (isLeader) {
  // ★ 新增：先拿成员快照（必须在 CASCADE 删除之前查）
  // 注意：由于 leader instance 已被 DELETE，CASCADE 可能已清空 team/team_members。
  // 因此 members 列表要在 handler 最开头就查好（移到 findByInstance 之后立即查）。
  const members = team.listMembers(t.id); // ← 移到更前面

  for (const m of members) {
    if (m.instanceId === e.instanceId) continue; // 跳过 leader 自身
    forceDeleteInstance(eventBus, m.instanceId);
  }

  eventBus.emit({
    ...makeBase('team.disbanded', 'bus/team.subscriber'),
    teamId: t.id,
    reason: 'leader_gone',
  });
  return;
}
```

**关键时序问题**：`instance.deleted` 事件触发时，SQLite 的 `ON DELETE CASCADE` 在同一个事务中已经删了 `teams` 行和 `team_members` 行。所以 `team.listMembers(t.id)` 此时可能返回空。

解决方案：在 handler 进入后，第一步同时查 `findByInstance` + `listMembers`，把成员列表存为局部变量。如果 CASCADE 已经发生，需要改为直接查 `role_instances WHERE team_id = ?`（因为 `role_instances.team_id` 不是外键，不会被 CASCADE 删除）。

```typescript
// 更安全的写法：用 role_instances.team_id 冗余列反查
const memberInstances = db.prepare(
  `SELECT id, status FROM role_instances WHERE team_id = ? AND id != ?`
).all(t.id, e.instanceId);
```

#### 辅助函数

```typescript
// 级联下线单个成员 instance
function cascadeOfflineMember(
  eventBus: EventBus,
  instanceId: string,
  actor: string,
): void {
  const inst = RoleInstance.findById(instanceId);
  if (!inst) return;

  if (inst.status === 'ACTIVE') {
    inst.requestOffline(actor);
    eventBus.emit({
      ...makeBase('instance.offline_requested', 'bus/team.subscriber'),
      instanceId,
      requestedBy: actor,
    });
  }
  // PENDING / PENDING_OFFLINE → 直接删除
  if (inst.status === 'PENDING' || inst.status === 'PENDING_OFFLINE') {
    const previousStatus = inst.status;
    inst.delete();
    eventBus.emit({
      ...makeBase('instance.deleted', 'bus/team.subscriber'),
      instanceId,
      previousStatus,
      force: true,
    });
  }
}

// 强制删除 instance（不走状态机，crash 语义）
function forceDeleteInstance(eventBus: EventBus, instanceId: string): void {
  const inst = RoleInstance.findById(instanceId);
  if (!inst) return;
  const previousStatus = inst.status;
  inst.delete();
  eventBus.emit({
    ...makeBase('instance.deleted', 'bus/team.subscriber'),
    instanceId,
    previousStatus,
    force: true,
  });
}
```

### 3.2 teams.sql 改动

新增 partial unique index，确保同一 leader 只能有一个 ACTIVE team：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_active_leader
  ON teams(leader_instance_id) WHERE status = 'ACTIVE';
```

### 3.3 team.ts (DAO) 改动

#### 新增方法: `findActiveByLeader`

```typescript
findActiveByLeader(leaderInstanceId: string): TeamRow | null {
  const row = getDb()
    .prepare(`SELECT ${TEAM_COLS} FROM teams WHERE leader_instance_id=? AND status='ACTIVE'`)
    .get(leaderInstanceId) as TeamDbRow | undefined;
  return row ? rowToTeam(row) : null;
}
```

#### 修改: `create()` 方法

在 INSERT 前加校验：

```typescript
create(input: CreateTeamInput): TeamRow {
  const existing = this.findActiveByLeader(input.leaderInstanceId);
  if (existing) {
    throw new Error(`leader '${input.leaderInstanceId}' already has active team '${existing.id}'`);
  }
  // ... 原有逻辑
}
```

#### 新增方法: `listMemberInstanceIds`（可选）

用 `role_instances.team_id` 冗余列反查，不依赖 team_members 表（应对 CASCADE 后查不到的问题）：

```typescript
listMemberInstanceIds(teamId: string): string[] {
  const rows = getDb()
    .prepare(`SELECT id FROM role_instances WHERE team_id = ?`)
    .all(teamId) as { id: string }[];
  return rows.map(r => r.id);
}
```

### 3.4 bus/types.ts 改动

#### 扩展 `TeamMemberLeftEvent.reason`

```typescript
// 当前
reason: 'manual' | 'instance_deleted';

// 改为
reason: 'manual' | 'instance_deleted' | 'offline_requested';
```

### 3.5 api/panel/teams.ts 改动

#### `handleCreateTeam` 错误码

现有 catch 已经返回 400。需要区分唯一约束冲突返回 409：

```typescript
try {
  const created = team.create({ ... });
  // ...
} catch (e) {
  const msg = (e as Error).message;
  if (msg.includes('already has active team')) {
    return errRes(409, msg);
  }
  return errRes(400, msg);
}
```

### 3.6 不需要新事件

现有 4 种 team 事件 + 4 种 instance 事件已足够覆盖所有 case。不需要新增事件类型。

---

## 4. 边界问题

### 4.1 级联下线时是 request_offline 还是直接 delete？

**结论：分情况处理。**

| 成员当前状态 | leader request_offline 触发 | leader deleted 触发 | manual disband 触发 |
|-------------|---------------------------|--------------------|--------------------|
| ACTIVE | `requestOffline` → 状态变 PENDING_OFFLINE → 后续由调用方或自动清理 delete | `force delete`（直接删，无需过渡） | `requestOffline`（优雅下线） |
| PENDING | `force delete`（还没激活，直接清理） | `force delete` | `force delete` |
| PENDING_OFFLINE | `force delete`（已在下线流程中，直接完成） | `force delete` | `force delete` |

**Why 区分**：
- leader request_offline 是优雅流程，给 ACTIVE 成员一个"收尾"窗口（PENDING_OFFLINE 状态下成员 PTY 还在跑，可以保存工作）。
- leader deleted 是崩溃/强制清理语义，必须立刻释放所有资源。
- manual disband 同样走优雅路径。

### 4.2 leader 下线级联时，成员 instance 是 PENDING 状态怎么处理？

PENDING 状态的成员 instance 还没有 activate（PTY 可能还在 spawn 或已 spawn 但未 register session）。

**处理方式**：直接 `force delete`。原因：
1. PENDING 状态不能走 `requestOffline`（状态机只允许 ACTIVE → PENDING_OFFLINE）。
2. PENDING 的 instance 还没真正上线，没有"优雅下线"的必要。
3. `instance.deleted` 事件会触发 `pty.subscriber` 的 `ptyManager.kill()`，清理可能已经 spawn 的 PTY 进程。

### 4.3 循环触发风险分析

最危险的链路：

```
成员 request_offline
  → team.subscriber: removeMember → 不检查空 team（leader 还在，可以再拉人）
  → 安全终止 ✓

leader request_offline
  → team.subscriber: 级联 requestOffline 所有 ACTIVE 成员 → emit instance.offline_requested
  → team.subscriber 再次收到 instance.offline_requested（成员的）
  → findByInstance → team 已被 disband（status=DISBANDED）→ findByInstance 返回 null
  → 安全终止 ✓（前提：findByInstance 要过滤 DISBANDED 的 team）

leader deleted
  → team.subscriber: 级联 force delete 所有成员 → emit instance.deleted
  → team.subscriber 再次收到 instance.deleted（成员的）
  → findByInstance → team 已被 CASCADE 删除 → 返回 null
  → 安全终止 ✓
```

**防循环策略**：

1. **`findByInstance` 天然过滤**：team 被 disband 后 status=DISBANDED，被 CASCADE 删除后行不存在。只要 `findByInstance` 查的是 JOIN 活跃 team（即 `status='ACTIVE'`），级联事件进入 handler 时查不到 team，直接 return。

2. **`team.disbanded` handler 只处理 reason='manual'**：leader_gone 和 empty 的级联已经在触发端处理了，disbanded handler 不需要重复做。

3. **`team.member_left` handler 只处理 reason='manual'**：避免 offline_requested / instance_deleted 触发的 member_left 再次触发下线。

**需要修改 `findByInstance`**：当前实现没有过滤 `status='ACTIVE'`，需要加条件：

```sql
-- 当前
WHERE tm.instance_id = ?

-- 改为
WHERE tm.instance_id = ? AND t.status = 'ACTIVE'
```

### 4.4 instance.deleted 的 CASCADE 时序

SQLite 的 `ON DELETE CASCADE` 在 `DELETE FROM role_instances` 的同一个事务中执行。当 `instance.deleted` 事件到达 team.subscriber 时，事务已提交，CASCADE 已完成。

这意味着：
- `team.findByInstance(leaderId)` → **可能返回 null**（team 行已被 CASCADE 删除）
- `team.listMembers(teamId)` → **可能返回空**（team_members 行已被 CASCADE 删除）

**解决方案**：在 `handleDeleteInstance` emit 事件之前（即 `instance.delete()` 之前），先查好 team 信息并附加到事件 payload。或者在 subscriber 中用 `role_instances.team_id` 冗余列反查（该列不受 CASCADE 影响，因为不是外键引用 teams 表）。

**推荐方案**：在 subscriber 的 `instance.deleted` handler 中，改用 `role_instances.team_id` 冗余列反查成员列表：

```typescript
// 先用 e.instanceId 查 role_instances.team_id（但 leader instance 已被删除...）
// ↑ 不行，leader 行已经不存在了

// 真正可靠的方案：在 emit instance.deleted 之前，把 teamId 和 isLeader 附加到事件 payload
```

**最终推荐**：扩展 `InstanceDeletedEvent` payload，增加 `teamId` 和 `isLeader` 字段：

```typescript
export interface InstanceDeletedEvent extends BusEventBase {
  type: 'instance.deleted';
  instanceId: string;
  previousStatus: string;
  force: boolean;
  teamId: string | null;     // ★ 新增
  isLeader: boolean;          // ★ 新增
}
```

在 `handleDeleteInstance` 中，emit 之前读取这些信息（此时 instance 还没被 delete）：

```typescript
const previousStatus = instance.status;
const teamId = instance.teamId;
const isLeader = instance.isLeader;
instance.delete(); // CASCADE 在这里发生

bus.emit({
  ...makeBase('instance.deleted', 'api/panel/role-instances'),
  instanceId: id,
  previousStatus,
  force,
  teamId,    // ★ 新增
  isLeader,  // ★ 新增
});
```

subscriber 中用这些字段判断，不再调 `findByInstance`（因为它可能被 CASCADE 清掉了）。

### 4.5 `instance.offline_requested` 的 CASCADE 问题

`requestOffline` 不删 instance，不会触发 CASCADE。所以 `findByInstance` 可以正常工作，不存在 4.4 的问题。

### 4.6 disband 后再 removeMember 是否安全？

`team.disband()` 只改 status 和 disbanded_at，不删 team_members 行。所以 disband 后 `removeMember` 仍然可以正常工作（DELETE FROM team_members WHERE ...）。

但如果 team 是被 CASCADE 删除的（leader 被 delete），team 行和 team_members 行都已消失，此时 `removeMember` 是 no-op（DELETE 0 rows），安全。

---

## 5. 改动文件汇总

| 文件 | 改动类型 | 内容 |
|------|---------|------|
| `bus/subscribers/team.subscriber.ts` | **大改** | 新增 3 个订阅（offline_requested / disbanded / member_left），修改 instance.deleted handler，新增 cascadeOfflineMember / forceDeleteInstance 辅助函数 |
| `bus/types.ts` | 小改 | InstanceDeletedEvent 加 teamId + isLeader 字段；TeamMemberLeftEvent.reason 加 'offline_requested' |
| `db/schemas/teams.sql` | 小改 | 加 partial unique index uq_teams_active_leader |
| `team/team.ts` | 小改 | 新增 findActiveByLeader 方法，create() 加唯一校验，可选新增 listMemberInstanceIds |
| `team/team.ts` → `findByInstance` | 小改 | WHERE 条件加 `t.status = 'ACTIVE'` |
| `api/panel/teams.ts` | 小改 | handleCreateTeam 错误码区分 409 |
| `api/panel/role-instances.ts` | 小改 | handleDeleteInstance emit 前读取 teamId + isLeader，附加到事件 payload |
| `domain/role-instance.ts` | 不改 | 无变化 |

---

## 6. 实现顺序建议

1. **Step 1: types.ts** — 先改事件类型定义，让编译器帮检查所有发射点
2. **Step 2: teams.sql + team.ts** — 加 unique index + findActiveByLeader + 改 findByInstance
3. **Step 3: role-instances.ts** — handleDeleteInstance emit 带上 teamId / isLeader
4. **Step 4: team.subscriber.ts** — 核心逻辑，依赖 Step 1-3
5. **Step 5: teams.ts (API)** — handleCreateTeam 错误码
6. **Step 6: 测试** — 每个 case 至少一个测试用例
