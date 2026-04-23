# Phase 2 — 角色实例生命周期 + 终端进程

> Phase 2 把 Phase 1 的纯数据层变成**活的东西**：每个 `role_instances` 行对应一个正在运行的 Claude CLI 子进程。
> 本文档覆盖 spawn / register / kill 全链路，以及提示词组装、PTY 管理、HTTP 接口。

---

## 1. 目标

- 角色实例的完整生命周期：**创建 → spawn CLI → CLI 注册 session → activate → 工作 → 删除 → kill**。
- 实例 = 数据（DB 行）+ 进程（PTY 句柄），**生死一体**：
  - 创建实例 → 必然 spawn 一个 CLI 子进程。
  - 删除实例 → 必然 kill 对应的 CLI 子进程。
- 终端能力是**实例生命周期的一部分**，不是独立模块，不暴露独立的"PTY API"。
- 上层只看到三个动作：`POST /api/role-instances`、`GET /api/role-instances`、`DELETE /api/role-instances/:id`。

---

## 2. 状态机

Phase 2 三态状态机（在 Phase 1 基础上扩到三态，因下线需要 leader 批准）：

```
PENDING ──(CLI 注册 session)──▶ ACTIVE ──(leader 批准)──▶ PENDING_OFFLINE ──(成员 deactivate)──▶ 物理删除
                                   │                              │
                                   └──────── crash ───────────────┴────────▶ 物理删除（reaper）
```

| 状态 | 含义 |
|------|------|
| `PENDING`          | 实例刚创建，CLI 进程正在启动，尚未通过 `/api/sessions/register` 回调注册。 |
| `ACTIVE`           | CLI 已连上 server，`session_id` / `session_pid` 已写入，agent 可以工作。 |
| `PENDING_OFFLINE`  | leader 已批准成员下线；等待成员调 `deactivate` 自觉退出。此状态下成员仍在跑，但 leader 不应再派新任务。 |

**删除不是状态**：行从表中物理消失，没有 OFFLINE 终态。`role_state_events` 保留完整历史。
Phase 2 不引入 ACTIVATING / PENDING_DEPARTURE 等其他扩展态。

状态流（事件 → 目标）：

| 事件 | 触发方 | from | to | 说明 |
|------|--------|------|-----|------|
| `create_instance`    | Panel / API 调用方 | （无）   | `PENDING`         | 写入 DB 同时 spawn CLI。 |
| `register_session`   | CLI 子进程回调      | `PENDING` | `ACTIVE`          | 写 `session_id` / `session_pid`。 |
| `request_offline`    | leader（通过 MCP）  | `ACTIVE`  | `PENDING_OFFLINE` | 写 state_event；通过 comm 推系统消息通知目标。 |
| `deactivate`         | 成员自己（通过 MCP）| `PENDING_OFFLINE` | （删除） | 物理 DELETE + kill 进程 + state_event。 |
| `crash`              | reaper / exit 监听 | 任意非删除 | （删除） | 进程异常退出，直接物理删除 + state_event。 |

**拒绝矩阵**：

| 调用 | 当前状态 | 结果 |
|------|----------|------|
| `activate`        | 非 `PENDING`              | 409（已 activate / 不存在） |
| `request_offline` | 目标非 `ACTIVE`            | 409（已在下线流程或尚未 activate） |
| `request_offline` | 调用者 `is_leader != 1`    | 403 |
| `deactivate`      | 非 `PENDING_OFFLINE`       | 409（ACTIVE 返回"需要 leader 批准下线"；PENDING 返回"尚未 activate"） |

**为什么加 PENDING_OFFLINE**：避免成员自行下线导致 leader 还在派任务时对方已消失；下线必须是 leader 决策、成员执行的两步动作。

---

## 3. 完整生命周期时序图

### 3.1 创建流程

```
调用方               HTTP server            RoleInstance(DB)          PtyManager            Claude CLI 子进程
  │                     │                        │                        │                        │
  │ POST /api/role-     │                        │                        │                        │
  │  instances {...}    │                        │                        │                        │
  │────────────────────▶│                        │                        │                        │
  │                     │ validate + template 存在                         │                        │
  │                     │────────────────────────▶                        │                        │
  │                     │ INSERT status=PENDING  │                        │                        │
  │                     │────────────────────────▶                        │                        │
  │                     │ instance.id 返回        │                        │                        │
  │                     │◀────────────────────────                        │                        │
  │                     │                        │                        │                        │
  │                     │ pty.spawn(instance)    │                        │                        │
  │                     │───────────────────────────────────────────────▶ │                        │
  │                     │                        │                        │ 组装 CLI 参数 / env     │
  │                     │                        │                        │ node-pty.spawn()        │
  │                     │                        │                        │───────────────────────▶ │
  │                     │                        │                        │                        │ CLI 启动
  │                     │                        │                        │                        │ 加载 --mcp-config
  │                     │                        │                        │                        │ 内部 stdio proxy 启动
  │                     │ 响应 201 { instance }  │                        │                        │
  │◀────────────────────│                        │                        │                        │
  │                     │                        │                        │                        │
  │  （此时 status=PENDING，等 CLI 回调）                                   │                        │
  │                     │                        │                        │ POST /api/sessions/register
  │                     │◀────────────────────────────────────────────────────────────────────────│
  │                     │ 校验 instance_id       │                        │                        │
  │                     │────────────────────────▶                        │                        │
  │                     │ UPDATE session_id,     │                        │                        │
  │                     │ session_pid,status=ACTIVE                       │                        │
  │                     │────────────────────────▶                        │                        │
  │                     │ 200 OK                 │                        │                        │
  │                     │─────────────────────────────────────────────────────────────────────────▶│
  │                     │                        │                        │                        │ agent 进入工作循环
```

### 3.2 删除流程

```
调用方               HTTP server            RoleInstance(DB)          PtyManager            Claude CLI 子进程
  │                     │                        │                        │                        │
  │ DELETE /api/role-   │                        │                        │                        │
  │  instances/:id      │                        │                        │                        │
  │────────────────────▶│                        │                        │                        │
  │                     │ SELECT by id           │                        │                        │
  │                     │────────────────────────▶                        │                        │
  │                     │ 404 if not found       │                        │                        │
  │                     │                        │                        │                        │
  │                     │ pty.kill(instanceId)   │                        │                        │
  │                     │───────────────────────────────────────────────▶ │                        │
  │                     │                        │                        │ ptyHandle.kill('SIGTERM')│
  │                     │                        │                        │───────────────────────▶ │
  │                     │                        │                        │                        │ CLI 退出
  │                     │                        │                        │ exit 事件清理 buffer     │
  │                     │                        │                        │                        │
  │                     │ DELETE FROM            │                        │                        │
  │                     │  role_instances        │                        │                        │
  │                     │────────────────────────▶                        │                        │
  │                     │ INSERT role_state_events (to='DELETED')         │                        │
  │                     │────────────────────────▶                        │                        │
  │                     │ 204 No Content         │                        │                        │
  │◀────────────────────│                        │                        │                        │
```

**顺序关键**：先 kill 进程再删 DB 行。
进程 exit 事件到达时 DB 行可能已经不存在，`PtyManager` 要容忍"找不到实例"的情况（只清 buffer）。

### 3.3 异常路径

| 情景 | 处理 |
|------|------|
| spawn 失败（node-pty 抛错） | 立刻 DELETE 刚写的 PENDING 行，响应 500。 |
| CLI 启动后从未回调 register | 实例卡在 PENDING。Phase 2 不主动清理，由调用方 DELETE。 |
| CLI 进程先退出（崩溃） | PtyManager 收 `exit` 事件，清自己内部 buffer。DB 行不变，由调用方 DELETE 时清理。 |
| DELETE 时 PTY 已退出 | `pty.kill()` 内部判空即可，不抛错。 |

---

## 4. 提示词组装

### 4.1 来源

- **身份提示词**：`role_templates.persona`（Phase 1 已定义字段）。
- **成员名 / leader 身份**：来自 `CreateRoleInstanceInput`（`memberName` / `isLeader` / `leaderName`）。
- **任务**：来自 `CreateRoleInstanceInput.task`。

### 4.2 模板

同一个模板，`isLeader` 分支替换一行：

```
# 系统提示
你是 M-Team 体系内的一个 Agent。你的工作围绕两件事展开：
1、利用 mnemo 完成用户的任何任务
2、围绕 mteam 完成团队协作

# 角色
{ isLeader ? "本轮你被指派为 Leader。" : "本轮你的 Leader 是 ${leaderName}。" }
你的名字是：{memberName}，你的身份是：{persona}

# 任务
{task}
```

缺省处理：
- `task` 为空时，该段输出为 `# 任务\n（暂无具体任务，等待 Leader 分配）`。
- `isLeader=false` 但 `leaderName` 为空时，该行替换为 `本轮你尚未绑定 Leader。`（Phase 2 允许，后续 Phase 再严格校验）。

### 4.3 传给 CLI 的方式

CLI 启动参数（由 `PtyManager.spawn` 组装）：

```
claude \
  --mcp-config       <mcpConfigPath>          # 只包含 teamhub
  --append-system-prompt  <assembledPrompt>   # §4.2 的整段字符串
  --dangerously-skip-permissions              # agent 内部操作不阻塞
```

- `--mcp-config`：一个临时 JSON 文件，只含 `teamhub` 这一个 MCP server 条目（指向当前 server 进程的 stdio proxy 入口）。**不注入其他 MCP**，避免成员越权调用用户侧工具。
- `--append-system-prompt`：直接把 §4.2 组装好的整段字符串传进去。由于参数可能很长，在 `spawn` 之前把 prompt 落成临时文件也可以（可选优化，Phase 2 默认直接传参）。
- `--dangerously-skip-permissions`：agent 自身操作不被权限提示卡住；用户侧的权限仍由调用方把关。

---

## 5. PTY 管理

### 5.1 `v2/pty/manager.ts`（新增）

```ts
export interface SpawnOptions {
  instanceId: string;
  memberName: string;
  isLeader: boolean;
  leaderName: string | null;
  task: string | null;
  persona: string | null;
  cols?: number;        // 默认 120
  rows?: number;        // 默认 32
  cwd?: string;         // 默认 process.cwd()
}

export interface PtyEntry {
  instanceId: string;
  pid: number;
  handle: IPty;           // node-pty 句柄
  buffer: RingBuffer;     // 最近 stdout
  spawnedAt: string;      // ISO
}

export class PtyManager {
  /** 创建 + 启动；返回 pid */
  spawn(opts: SpawnOptions): PtyEntry;

  /** 给 CLI 的 stdin 写数据（推送团队消息 / 注入 activate 指令） */
  write(instanceId: string, data: string): void;

  /** 读最近 stdout 片段（重连回放） */
  readBuffer(instanceId: string, maxBytes?: number): string;

  /** SIGTERM → 等待 2s → SIGKILL；清 buffer；幂等 */
  kill(instanceId: string): void;

  /** 调试：当前所有活进程 */
  list(): PtyEntry[];
}

export const ptyManager: PtyManager;   // 进程内单例
```

实现要点：
- `spawn` 内部：
  1. 读 `role_templates` 拿 `persona`（调用方传入即可，避免 PTY 层依赖 DB）。
  2. 组装 §4.2 的 prompt 字符串。
  3. 生成 `--mcp-config` 临时文件（os.tmpdir / `mteam-<instanceId>.json`），进程退出时清理。
  4. `node-pty.spawn(cliBin, cliArgs, { env, cwd, cols, rows })`。
  5. `handle.onData(chunk => { buffer.push(chunk); detectReadyIfNeeded(chunk) })`。
  6. `handle.onExit(() => cleanup(instanceId))`。
- **CLI ready 检测**（可选）：正则匹配 `bypass permissions` 或 `shift+tab` 之类标志串，标记进程"已进入交互态"。主要用途是调试，Phase 2 不阻塞调用方（POST 在 spawn 返回时立刻响应）。
- **ring buffer**：固定大小（默认 64KB）的滑动字节缓冲，淘汰最老的 chunk。Phase 2 不对外暴露 SSE / tail，但 `readBuffer` 留给排障 / 重连回放用。
- **kill 幂等**：
  ```ts
  const entry = map.get(instanceId);
  if (!entry) return;
  try { entry.handle.kill('SIGTERM'); } catch { /* already exited */ }
  setTimeout(() => { try { entry.handle.kill('SIGKILL'); } catch {} }, 2000);
  map.delete(instanceId);
  ```

### 5.2 stdin 写入场景

Phase 2 不触发任何 server→PTY 推送，但接口先暴露：
- 将来"给成员推送新消息"时，`messages.ts` 调 `ptyManager.write(toInstanceId, '\n# 新消息\n...')`。
- 将来"强制注入 activate 指令"时同理。

---

## 6. sessions 注册

### 6.1 CLI 如何知道自己是谁

`spawn` 时通过 env 传入：

| 变量 | 值 | 用途 |
|------|-----|------|
| `ROLE_INSTANCE_ID`   | instance.id                | CLI 内部 stdio proxy 拿去注册 |
| `CLAUDE_MEMBER`      | instance.memberName        | proxy / 日志显示 |
| `IS_LEADER`          | `'1'` / `'0'`              | proxy 决定用哪套默认行为 |
| `TEAM_HUB_NO_LAUNCH` | `'1'`                      | 告知 proxy：hub 已在跑，不要再启一份 |

### 6.2 stdio proxy 自动注册

Claude CLI 启动后加载 `--mcp-config` 指定的 teamhub MCP server（即 stdio proxy 进程）。proxy 第一件事：

```ts
const instanceId = process.env.ROLE_INSTANCE_ID;
if (instanceId) {
  await fetch(`${HUB_URL}/api/sessions/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId, pid: process.pid }),
  });
}
```

### 6.3 server 侧 `/api/sessions/register`

新增路由，在 `server.ts` 中注册：

- **方法**：`POST`
- **路径**：`/api/sessions/register`
- **请求体**：`{ instanceId: string, pid: number }`
- **处理**：
  1. `RoleInstance.findById(instanceId)` → 404 if not found。
  2. 生成 `sessionId = randomUUID()`。
  3. 原子事务：
     ```sql
     UPDATE role_instances
        SET session_id = ?, session_pid = ?, status = 'ACTIVE'
      WHERE id = ?;
     INSERT INTO role_state_events (instance_id, from_state, to_state, event, actor, at)
       VALUES (?, 'PENDING', 'ACTIVE', 'register_session', NULL, ?);
     ```
  4. 返回 `{ sessionId }`（CLI 侧 proxy 保留，后续请求携带）。

**一对一绑定**：一个实例只允许注册一次。重复 POST → 409。
`session_id` 列上已有 `UNIQUE` 约束（Phase 1 schema），天然去重。

---

## 7. 接口设计（Phase 2 最终）

| Method | Path | 行为 |
|-------:|------|------|
| `POST`   | `/api/role-instances`                       | 创建实例 + spawn CLI，立刻返回（status=PENDING） |
| `GET`    | `/api/role-instances`                       | 列出全部实例 |
| `POST`   | `/api/role-instances/:id/activate`          | `PENDING → ACTIVE`，返回 `{ status, persona, task, leaderName }` |
| `POST`   | `/api/role-instances/:id/request-offline`   | leader 批准目标下线：`ACTIVE → PENDING_OFFLINE` + comm 推系统消息 |
| `DELETE` | `/api/role-instances/:id`                   | 要求 `status = PENDING_OFFLINE`，kill CLI + 物理删除 + 审计事件；其他状态 409（Panel 可 `?force=1` 走 crash 路径） |
| `POST`   | `/api/sessions/register`                    | **Phase 2 新增**：CLI 回调注册 session |

其他：
- 不暴露 `/api/pty/*`。终端能力通过上面接口已完整覆盖。
- 不暴露 `/api/role-instances/:id/kill` 之类"只杀进程不删数据"的半截接口 —— 避免 DB 与进程状态不一致。

---

## 8. 新增 / 改动文件清单

| 文件 | 类型 | 行数 | 职责 |
|------|------|------:|------|
| `v2/pty/manager.ts`                     | 新增 | ~120 | PTY spawn / kill / write / ring buffer / 单例 |
| `v2/pty/prompt.ts`                      | 新增 | ~60  | §4.2 提示词模板拼装（纯函数，便于单测） |
| `v2/api/panel/sessions.ts`              | 新增 | ~60  | `handleRegisterSession(body)` |
| `v2/api/panel/role-instances.ts`        | 改动 | +60  | `handleCreateInstance` 末尾调 `ptyManager.spawn`；`handleActivate`（`PENDING → ACTIVE`）；`handleRequestOffline`（leader 校验 + `ACTIVE → PENDING_OFFLINE` + comm 推消息）；`handleDeleteInstance` 要求 `PENDING_OFFLINE`，调 `ptyManager.kill` |
| `v2/server.ts`                          | 改动 | +30  | 注册 `/api/sessions/register`、`/api/role-instances/:id/activate`、`/api/role-instances/:id/request-offline` 路由 |
| `v2/domain/role-instance.ts`            | 改动 | +30  | 增加 `registerSession(sessionId, pid)`、`activate(actor)`、`requestOffline(actorInstanceId)` 方法，内部走事务 + 写 state_event |
| `v2/domain/state-machine.ts`            | 改动 | +15  | 状态枚举扩为 `PENDING / ACTIVE / PENDING_OFFLINE`；事件 `register_session` / `request_offline` / `deactivate` / `crash` + 转换表 |

**所有新增 / 改动文件严格 < 200 行。** 超过必拆。

---

## 9. env 变量传递总表

| 变量 | 来源 | 传递路径 | 消费方 |
|------|------|----------|--------|
| `ROLE_INSTANCE_ID`   | `RoleInstance.create` 返回的 `id` | `ptyManager.spawn` → CLI env | stdio proxy（`sessions/register`） |
| `CLAUDE_MEMBER`      | `CreateRoleInstanceInput.memberName` | 同上 | stdio proxy 日志 / 系统提示 |
| `IS_LEADER`          | `CreateRoleInstanceInput.isLeader`   | 同上（`'1'` / `'0'`） | stdio proxy 行为分支 |
| `TEAM_HUB_NO_LAUNCH` | 常量 `'1'` | 同上 | stdio proxy 启动逻辑 |

其他 env 继承自 server 进程（`PATH` / `HOME` 等），不做裁剪。

---

## 10. 验收标准

跑通以下脚本视为 Phase 2 完成：

```ts
// 1. 建模板
await fetch('http://localhost:58580/api/role-templates', {
  method: 'POST',
  body: JSON.stringify({ name: '刺猬', role: 'qa', persona: '你是测试，擅长挑刺' }),
});

// 2. 创建实例 + spawn CLI
const r = await fetch('http://localhost:58580/api/role-instances', {
  method: 'POST',
  body: JSON.stringify({ templateName: '刺猬', memberName: '刺猬-01', task: '测 vault 模块' }),
});
const inst = await r.json();
// 断言：inst.status === 'PENDING'，ptyManager.list() 有一条，pid 存活

// 3. 等 CLI 注册回调（最多 10s）
await pollUntil(() => fetch(`/api/role-instances`).then(r => r.json())
                     .then(list => list[0].status === 'ACTIVE'));
// 断言：session_id 非空，session_pid 与 pty pid 相等

// 4. 删除实例
await fetch(`http://localhost:58580/api/role-instances/${inst.id}`, { method: 'DELETE' });
// 断言：ptyManager.list() 为空；进程不存在（kill -0 pid 抛错）；DB 行消失
// 断言：role_state_events 至少 3 条（create / register_session / delete）
```

可以 `TEAM_HUB_DB=:memory:` 跑内存库；PTY 部分建议跑真实文件 DB 以便重启后 orphan 检测（留给 Phase 3）。

---

## 11. 明确不做（Phase 2 边界）

- **进程探活 / reaper**：CLI 无响应不自动清理，留给 Phase 3。
- **重连回放 / SSE stdout 推送**：`ring buffer` 内部已具备能力，但不暴露接口。
- **多套 MCP 注入**：`--mcp-config` 只放 teamhub 一条。
- **权限细化**：`--dangerously-skip-permissions` 统一开着；Panel 侧隔离由 Phase 4 处理。
- **状态扩展**：三态 PENDING / ACTIVE / PENDING_OFFLINE；OFFLINE / PENDING_DEPARTURE 等更细分态是 Phase 3 及以后的事。
- **messages / team / project 级联**：Phase 2 不动 team_members / project_members 自动化规则，那是 Phase 3。

---

## 12. 代码改动清单（引入 PENDING_OFFLINE 状态）

为让"leader 批准 → 成员自觉退出"成立，以下代码文件需配套改动。本节只列清单，实际编码不在本文档范围。

### 12.1 `v2/domain/state-machine.ts`

- `RoleStatus` 枚举加 `PENDING_OFFLINE = 'PENDING_OFFLINE'`。
- `TransitionEvent` 枚举加 `REQUEST_OFFLINE = 'request_offline'`；复用已有 `DEACTIVATE` / `CRASH`；`register_session` 保留。
- `TransitionRule.to` 放宽为 `RoleStatus | null`（null = 物理删除）。
- `TRANSITIONS` 常量表加两条、改一条：
  - `{ event: REQUEST_OFFLINE, from: [ACTIVE], to: PENDING_OFFLINE }`
  - `{ event: DEACTIVATE, from: [PENDING_OFFLINE], to: null, terminal: true }`
  - `{ event: CRASH, from: [PENDING, ACTIVE, PENDING_OFFLINE], to: null, terminal: true }`
- `resolveTransition` 返回类型跟随 `to` 的变化。
- 单测：补 `PENDING→PENDING_OFFLINE` 非法（应走 ACTIVE）、`ACTIVE→deactivate` 非法、`PENDING_OFFLINE→deactivate` 合法三个用例。

### 12.2 `v2/db/schemas/role_instances.sql`

- `CHECK(status IN (...))` 里加入 `'PENDING_OFFLINE'`，完整集合改为 `('PENDING','ACTIVE','PENDING_OFFLINE')`。
- 若已有历史数据库文件，Phase 2 阶段直接 `DROP TABLE` 重建（V2 尚未发版，无迁移负担）；后续 Phase 再视情况引入 migration。
- `INDEX` 不变。

### 12.3 `v2/domain/role-instance.ts`

- 新增实例方法：
  - `activate(actor: string | null): void` — 走 `REGISTER_SESSION` 或专用 `activate` 事件（按 state-machine 定义），`PENDING → ACTIVE`，写 `role_state_events`。
  - `requestOffline(actorInstanceId: string): void` — 断言 `this.status === ACTIVE`；`ACTIVE → PENDING_OFFLINE`；事务里写 `role_state_events(from='ACTIVE', to='PENDING_OFFLINE', trigger_event='request_offline', actor=actorInstanceId)`；**权限判定由 handler 层做，domain 层只做状态校验**。
  - （可选）`markCrash(reason)` — 封装 `CRASH` 路径，供 reaper 调用。
- `destroy()` 改为 `transition(DEACTIVATE)` 的语义糖，内部走"物理删除 + 写 state_event"分支。
- `transition()` 扩展终态处理：`terminal=true` 时执行 `DELETE FROM role_instances WHERE id=?`，不再写 `destroyed_at` / `destroy_reason`（该两列若已存在，顺手移除）。

### 12.4 `v2/api/panel/role-instances.ts`

- 新增 handler：
  - `handleActivate(req, { id })` — 调 `RoleInstance.findById(id).activate(null)`；返回 `{ status, persona, task, leaderName }`；persona 从 `RoleTemplate.findByName(inst.templateName).persona` 取。
  - `handleRequestOffline(req, { id })` — 从 header `X-Role-Instance-Id`（或 body `callerInstanceId`）取调用者 id；校验调用者存在且 `is_leader = 1`（否则 403）；目标 `status = ACTIVE`（否则 409）；调 `RoleInstance.requestOffline(caller.id)`；通过 comm socket 发送系统消息给目标（summary/content 如 §2 "request_offline" 所述）；返回 `{ status: 'PENDING_OFFLINE' }`。
- 修改 handler：
  - `handleDeleteInstance(req, { id })` — 前置校验目标 `status === PENDING_OFFLINE`，否则 409；保留 `?force=1` 绕过，用于 Panel 侧管理员强杀，内部走 `CRASH` 事件。
  - `handleCreateInstance` 不变（仍落 PENDING + spawn）。

### 12.5 `v2/server.ts`

- 注册路由：
  - `POST /api/role-instances/:id/activate` → `handleActivate`
  - `POST /api/role-instances/:id/request-offline` → `handleRequestOffline`
- `DELETE /api/role-instances/:id` 已存在，不重复注册，仅 handler 内逻辑变化（见 12.4）。
- `/api/sessions/register` 路由保持不变（仍是 `PENDING → ACTIVE` 的底层入口；MCP 的 `activate` 工具走 `/api/role-instances/:id/activate` 走应用层事件，两条路径任选其一保留即可；Phase 2 默认双保留，后续 Phase 再裁剪）。

### 12.6 mteam MCP 子进程（`v2/mteam-mcp/...`）

- `tools/deactivate.ts`：调用前无须本地判状态，直接 `DELETE ${V2_SERVER_URL}/api/role-instances/${ROLE_INSTANCE_ID}`，错误透传（409 "需要 leader 批准下线" / "尚未 activate"）。
- `tools/request_offline.ts`（新增）：`POST /api/role-instances/${input.instanceId}/request-offline`，header 带 `X-Role-Instance-Id: ${ROLE_INSTANCE_ID}`。
- `server.ts`：注册 5 个工具（原 4 个 + `request_offline`）。

### 12.7 测试

- `v2/domain/__tests__/state-machine.test.ts`：补三态转换用例（见 12.1）。
- `v2/api/panel/__tests__/role-instances.test.ts`：补
  - leader 调 `request-offline` 成功（ACTIVE → PENDING_OFFLINE）；
  - 非 leader 调 `request-offline` 返回 403；
  - 目标非 ACTIVE 时 409；
  - 成员 ACTIVE 调 DELETE 返回 409；PENDING_OFFLINE 调 DELETE 成功；
  - 目标收到系统消息（断言 messages 表写入）。

以上改动均为 Phase 2 必须。12.1 / 12.2 属于破坏性改动（状态机 / DB CHECK 约束），应优先落地再做 12.3+。
