# Phase 5 · 设计文档：团队工作流模板（项目模板）

> 状态：DRAFT v1 — 2026-04-27
> 受众：后端 + 前端 + 主 Agent MCP 侧，用户视角包装也在本文
> 依赖：phase-primary-mcp（mteam-primary）、phase4（ActionItem + Ticker）、phase3（role templates）

---

## §1 背景与目标

### 1.1 用户原话
> "团队工作流模板看下怎么实现，接口设计，怎么启动，给用户怎么包装好一点，和直接创建的团队什么关系？用户怎么能更容易理解和接收并愿意使用？"

### 1.2 现状能做什么
- **角色模板（role template）**：定义一个人。`frontend-dev / qa-engineer / code-reviewer` 等 11 个内置模板落库（`src/domain/default-templates.ts`）。
- **实例 + 团队**：`POST /api/role-instances` 创建单人实例，`POST /api/teams` 开团，`POST /api/teams/:id/members` 拉人。
- **主 Agent MCP（mteam-primary）**：`create_leader` 一键完成上面三步（见 `src/mcp-primary/tools/create_leader.ts`）；`send_to_agent` 负责派任务 + 挂 ActionItem（kind≠chat + deadline）。
- **ActionItem + Ticker**：任务 deadline 到期前 10% 提醒 assignee，超时通知 creator（phase4 已落地）。

### 1.3 缺口
用户要开"一个代码审查的小团队"，现在必须手动：
1. 主 Agent 调 `create_leader` 建 leader；
2. 主 Agent 一个个调 `POST /api/role-instances` 建成员；
3. 再一条条 `send_to_agent` 派任务；
4. 成员间任务依赖（如 reviewer 完成 → 通知 tester）要靠主 Agent 自己维护状态机。

一套组合拳，每次要重打 10 次。**工作流模板就是把这套组合拳固化成"装机镜像"，用户点一下起一个完整团队。**

### 1.4 本期目标
1. **概念清晰**：工作流模板 vs 角色模板 vs 直接建团的关系，用户一眼就懂。
2. **包装亲和**：用户看到的不是"工作流模板"而是"项目模板 / 团队方案 / 套餐"。
3. **一键启动**：`launch_workflow({ templateName, goal })` 一次调用 = leader + 全员 + 任务链。
4. **可扩展**：高级用户能存自定义模板，不需要改代码。
5. **5 个内置模板起步**：覆盖常见协作场景。

### 1.5 不在本期
- 不做模板市场 / 分享。
- 不做复杂任务依赖 DAG（只支持 `on_complete` 线性链）。
- 不做角色自动选型（模板里的 role 是写死的）。

---

## §2 概念模型

### 2.1 三层关系
```
角色模板（role template）      →  "一个人的人设"         frontend-dev
        ↓ 实例化
角色实例（role instance）      →  "某个具体上岗的人"     inst_abc123 = 小红
        ↓ 编队
团队（team）                   →  "一群人 + 一个 leader"  code-review-2026-01
        ↑ 由工作流模板一键生成
工作流模板（workflow template） →  "一整个团队的起装方案"  code-review
```

**区别一句话**：
- 角色模板 = 一个单兵的档案。
- 工作流模板 = 一整支部队 + 作战计划。

### 2.2 和"直接创建团队"的关系
| 维度 | 直接创建 | 工作流模板 |
|---|---|---|
| 谁发起 | 主 Agent 多次工具调用 | 主 Agent 一次调用 |
| 步骤 | create_leader → N × create_instance → N × add_member → N × send_to_agent | launch_workflow |
| 适合 | 一次性、临时、非标 | 重复场景、标准套路 |
| 可变性 | 100% 自由 | 固定编排（但 goal/deadline 动态填） |
| 类比 | 手动装系统 | 装机镜像 |

**重要：工作流模板最终产物和直接创建的团队完全一致** —— 都是 `teams` + `role_instances` + `team_members` + `action_items` 里的普通数据。模板只是**生成过程的压缩**，不是运行时的新物种。团队起来之后和手搓的没区别，都能正常 send_to_agent / disband_team / 查状态。

### 2.3 用户视角的再包装
**不要对用户说"工作流模板"。** 用户不关心实现，关心"我想干一件事"。

| 技术名（内部） | 用户名（面向终端） | 对应场景 |
|---|---|---|
| workflow template | **项目模板 / 团队方案 / 套餐** | "开一个项目" |
| launch_workflow | **开项目 / 起团** | "开一个代码审查项目" |
| customTemplate | **我的方案** | 老用户沉淀自己的套路 |

**交互剧本**：
1. 用户（对主 Agent）："帮我起一个代码审查小组，审 PR #42。"
2. 主 Agent 内部：匹配到 `code-review` 模板，调 `launch_workflow({ templateName: 'code-review', goal: '审 PR #42' })`。
3. 后端：创建 leader + reviewer + tester，自动派第一轮任务。
4. 前端：teamCanvas 自动唤起，用户看到三个卡片在动。
5. 用户："好了告诉我结论就行。"

整个过程用户没说过"模板""角色""实例"任何一个技术词。

---

## §3 数据模型

### 3.1 WorkflowTemplate 结构
```ts
interface WorkflowTemplate {
  // 标识
  name: string;              // 'code-review' — 系统键，唯一
  label: string;             // '代码审查' — 给用户看
  description: string;       // 一句话说明
  icon?: string;             // 可选图标（同 role template icon 规则）
  tags?: string[];           // ['dev', 'quality']，用于筛选

  // 成员编排
  roles: Array<{
    key: string;             // 在本模板内的角色键，如 'reviewer'（用于 taskChain 引用）
    templateName: string;    // 指向已有角色模板，如 'code-reviewer'
    memberNameHint?: string; // 默认成员名，如 '审查员'；可被 launch 入参覆盖
    isLeader: boolean;       // 必须且只能有 1 个 isLeader: true
    initialTask?: string;    // 模板作者写的默认任务，支持 {{goal}} / {{deadline}} 占位符
  }>;

  // 可选：任务链（顺序触发）
  taskChain?: Array<{
    from: string;                          // roles[].key
    to: string;                            // roles[].key
    trigger: 'on_complete' | 'on_resolve'; // 前者等 ActionItem done，后者 resolve/reject 都触发
    task: string;                          // 同样支持 {{goal}} 占位符
  }>;

  // 元
  builtin: boolean;          // true = 内置；false = 用户自定义
  createdAt: number;
  updatedAt: number;
}
```

**占位符规则**：`{{goal}}` / `{{deadline}}` / `{{projectName}}` 由 launch 入参填充；未填视作空串。

### 3.2 存储方式
- **内置模板**：硬编码在 `src/domain/default-workflow-templates.ts`，和角色模板 seed 一样走 `ensureDefaultTemplates` 幂等注入。
- **自定义模板**：落表 `workflow_templates`。

```sql
-- src/db/schemas/workflow_templates.sql
CREATE TABLE IF NOT EXISTS workflow_templates (
  name        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT NOT NULL,
  icon        TEXT,
  tags        TEXT,                   -- JSON array
  roles       TEXT NOT NULL,          -- JSON array
  task_chain  TEXT,                   -- JSON array
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

SCHEMA_VERSION bump：3 → 4。

### 3.3 校验规则（写入时）
- `roles` 至少 1 项，恰好 1 个 `isLeader: true`。
- 所有 `templateName` 必须在 `role_templates` 里存在。
- `taskChain` 里的 `from/to` 必须匹配 `roles[].key`。
- `name` 正则 `^[a-z][a-z0-9-]{1,63}$`，和角色模板同规则。

---

## §4 接口设计

### 4.1 两种方案对比

#### 方案 A：纯 HTTP 接口（panel 门面）
```
GET    /api/panel/workflows              — 列出可用模板（内置 + 自定义）
GET    /api/panel/workflows/:name        — 取单个
POST   /api/panel/workflows              — 创建自定义
PUT    /api/panel/workflows/:name        — 更新自定义（内置禁改）
DELETE /api/panel/workflows/:name        — 删除自定义
POST   /api/panel/workflows/:name/launch — 启动
```
launch 入参：
```ts
{ projectName?: string; goal: string; deadline?: number; overrides?: { [roleKey]: { memberName?: string } } }
```
响应：
```ts
{ teamId: string; leaderId: string; members: Array<{ key: string; instanceId: string }>; taskIds: string[] }
```

**优点**：
- 前端可以直接列表 + 选 + 启动，无需主 Agent 中转。
- 一次性创建多个实例有事务性需求，后端内部实现比主 Agent 多跳 HTTP 更稳。
- 测试容易（HTTP handler 单测 pattern 已有 20+ 例）。

**缺点**：
- 业务绕过了主 Agent 的"秘书"角色 —— 用户直接点按钮开团，主 Agent 不知道、对话历史里没记录、无法基于上下文给建议。

#### 方案 B：只走主 Agent MCP（mteam-primary 加一个 launch_workflow）
主 Agent 装一个新 MCP 工具：
```ts
launch_workflow({ templateName, goal, deadline?, projectName?, overrides? })
// 内部：读模板 → 按 roles 展开建 leader + instance + member + ActionItem
```
模板存 JSON 文件或 DB，由主 Agent 在工具内部解析。

**优点**：
- 走主 Agent，保留对话上下文，用户说"和上次一样" 主 Agent 能读历史。
- 不暴露 HTTP，减少攻击面。
- 符合"主 Agent 是总机"的架构定位。

**缺点**：
- 前端 UI（"模板商店"页面）也要列模板、支持自定义，纯 MCP 就得让前端通过主 Agent 中转查询，延迟和体验都差。
- 自定义模板的 CRUD 写在 MCP 工具里，schema 臃肿。

#### 方案 C（推荐）：HTTP 做 CRUD + 查询，MCP 做 launch
- **HTTP**：`GET/POST/PUT/DELETE /api/panel/workflows` —— 支持前端"模板商店"页面独立渲染、管理员维护自定义模板、也留给后续"模板市场"分享。
- **MCP**：`launch_workflow` —— 用户通过主 Agent 开团。前端"模板商店"的"启动"按钮也调主 Agent 而不是直调 HTTP，保证主 Agent 始终知情。

**推荐理由**：
- 读（list/get）和元数据写（create/update）是纯数据操作，没主 Agent 的事，走 HTTP 最轻。
- 启动（launch）是"发起业务动作" —— 和 `create_leader / send_to_agent` 同类，必须走主 Agent 以保持对话连续性和上下文感知。
- 此分工和 Phase 3 "数字员工走 WS，模板 CRUD 走 HTTP" 的决策思路一致。

### 4.2 HTTP 接口详单（方案 C）

```ts
// GET /api/panel/workflows?includeBuiltin=1&tag=dev
// 200 → WorkflowTemplate[]

// GET /api/panel/workflows/:name
// 200 → WorkflowTemplate
// 404 → { error: "workflow 'xxx' not found" }

// POST /api/panel/workflows
// body: Omit<WorkflowTemplate, 'builtin' | 'createdAt' | 'updatedAt'>
// 201 → WorkflowTemplate
// 409 → name 已存在
// 400 → 校验失败（roles 空 / leader 数量 ≠ 1 / 引用不存在的 role template）

// PUT /api/panel/workflows/:name
// body 同 POST，内置模板（builtin=1）拒改，返回 403
// 200 → WorkflowTemplate

// DELETE /api/panel/workflows/:name
// 内置拒删 403；有团队正在运行 → 409 放行（模板只是编排蓝图，不管运行时）
// 204

// POST /api/panel/workflows/:name/launch（最终会走 MCP，HTTP 仅用于 E2E 测试）
// body: { projectName?: string; goal: string; deadline?: number; overrides?: Record<string, { memberName?: string }> }
// 201 → { teamId, leaderId, members, taskIds }
```

### 4.3 MCP 工具

在 `src/mcp-primary/tools/` 下新增：

```ts
// list_workflows — 给主 Agent 列模板以便匹配用户意图
{
  name: 'list_workflows',
  description: 'List available workflow templates for project kickoff.',
  inputSchema: { type: 'object', properties: { tag: { type: 'string' } } }
}
// → 返回 Array<{ name, label, description, tags, roleCount }>

// launch_workflow
{
  name: 'launch_workflow',
  description:
    'Launch a pre-configured team in one shot: creates leader + members + initial tasks from a workflow template. ' +
    'Use list_workflows first if unsure which template fits. ' +
    'goal is required; deadline optional (absolute ms epoch).',
  inputSchema: {
    type: 'object',
    properties: {
      templateName: { type: 'string' },
      goal: { type: 'string' },
      projectName: { type: 'string' },
      deadline: { type: 'number' },
      overrides: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { memberName: { type: 'string' } }
        }
      }
    },
    required: ['templateName', 'goal'],
    additionalProperties: false
  }
}
// → { teamId, leaderId, members: [{ key, instanceId, memberName }], taskIds: [] }
```

实现要点：`launch_workflow` 内部**不自己展开**，而是调 HTTP `POST /api/panel/workflows/:name/launch`，复用同一套服务逻辑（避免两份实现）。这样 list/CRUD 走 HTTP、launch 也走 HTTP，MCP 工具只做参数转发 —— 和现有 `create_leader` 的模式完全一致（`create_leader` 也只是三次 HTTP 转发）。

---

## §5 内置模板（首批 5 个）

| name | label | 成员 | 任务链 |
|---|---|---|---|
| `code-review` | **代码审查** | leader(code-reviewer) + tester(qa-engineer) | leader 完成审查 → 触发 tester 跑回归 |
| `fullstack-feature` | **全栈开发** | leader(fullstack-dev) + frontend(frontend-dev) + backend(backend-dev) + qa(qa-engineer) | leader 拆任务 → 前后端并行 → 都完成 → qa 验收 |
| `bug-fix` | **Bug 修复** | leader(backend-dev) + qa(qa-engineer) | leader 定位修复 → qa 验证复现不再 |
| `tech-research` | **技术调研** | leader(tech-architect) + writer(tech-writer) | leader 出方案 → writer 写文档 |
| `docs-writing` | **文档编写** | leader(tech-writer) + reviewer(code-reviewer) | leader 初稿 → reviewer 审阅 |

**初版 initialTask 示例（`code-review`）**：
- leader：`请审查 {{goal}}，关注架构与边界条件，完成后将结论以 chat 发回主 Agent。`
- tester：`等待 reviewer 完成后接手回归测试。` （由 taskChain 覆盖实际 task）

**taskChain 示例（`code-review`）**：
```json
[
  {
    "from": "leader",
    "to": "tester",
    "trigger": "on_complete",
    "task": "reviewer 已完成审查。请针对 {{goal}} 跑回归测试用例，验证无新问题。"
  }
]
```

---

## §6 启动流程（launch 时序图）

```
用户 → 主Agent: "帮我开一个代码审查项目,审 PR #42"
主Agent → mnemo_search: "code review workflow" (找历史偏好)
主Agent → list_workflows: 列模板
主Agent: 匹配到 'code-review'
主Agent → launch_workflow({ templateName:'code-review', goal:'审 PR #42', deadline: now+2h })
launch_workflow → POST /api/panel/workflows/code-review/launch
  ├─ 1. 读模板 (workflow_templates / builtin)
  ├─ 2. 校验 goal / deadline / overrides
  ├─ 3. 展开 roles:
  │    for role in roles:
  │      POST /api/role-instances ({templateName, memberName, isLeader, task: render(role.initialTask)})
  │      → bus.emit instance.created → member-driver.start + roster.add
  │    POST /api/teams ({name: projectName, leaderInstanceId})
  │      → bus.emit team.created
  │    for non-leader instance:
  │      POST /api/teams/:id/members ({instanceId})
  │      → bus.emit team.member_joined
  ├─ 4. 为每个 role 的 initialTask 创建 ActionItem
  │    creator = 主Agent, assignee = 实例, deadline = launch.deadline
  │    → bus.emit action_item.created
  └─ 5. 注册 taskChain 监听器 (见 §7)

返回 { teamId, leaderId, members, taskIds }
主Agent → 用户: "已开团 code-review,3 人组,leader 正在处理 PR #42。完成后我告诉你。"
前端: team.created WS 事件触发 teamCanvas 自动唤起
```

### 6.1 失败回滚
- 任何一步 HTTP 失败 → 回滚已创建的 instance / team（调 `DELETE /api/role-instances/:id?force=1`）。
- **实现策略**：先在 `WorkflowService.launch` 内用 try/catch 包住，失败时把已创建的 id 列表逐一 force-delete。不引入跨 HTTP 的事务，简单粗暴但够用。

---

## §7 taskChain 实现

### 7.1 关键问题
任务链的触发点是 **ActionItem 状态变更**（`on_complete` = status: done），这是现成的 bus 事件 `action_item.resolved`。

### 7.2 设计：WorkflowChainSubscriber
新增 `src/bus/subscribers/workflow-chain.subscriber.ts`，订阅 `action_item.resolved` 事件：

```ts
// 伪码
bus.on('action_item.resolved', async (ev) => {
  const chainEntry = await chainStore.findByActionItemId(ev.item.id);
  if (!chainEntry) return;
  const { workflowRunId, stepIndex } = chainEntry;
  const nextSteps = getNextSteps(workflowRunId, stepIndex, ev.item.status);
  for (const step of nextSteps) {
    const nextInstance = lookupInstance(workflowRunId, step.to);
    // 建新 ActionItem,description = render(step.task,goal)
    createItem({ kind: 'task', assignee: { kind:'agent', id: nextInstance.id }, ... });
    // 给成员发消息 = runSendMsg,复用现有通路
    await runSendMsg({...}, comm, { to: nextInstance.memberName, content: renderedTask, kind:'task', deadline: ... });
  }
});
```

### 7.3 workflow_runs 存储
需要一张轻量表跟踪"哪个团队由哪个模板启动的 + 任务链进度"：

```sql
-- src/db/schemas/workflow_runs.sql
CREATE TABLE IF NOT EXISTS workflow_runs (
  id                TEXT PRIMARY KEY,                -- run_xxx
  template_name     TEXT NOT NULL,
  team_id           TEXT NOT NULL,
  goal              TEXT NOT NULL,
  role_instance_map TEXT NOT NULL,                   -- JSON: { roleKey: instanceId }
  chain_progress    TEXT NOT NULL DEFAULT '[]',      -- JSON: 已完成的 chain step 索引
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_chain_bindings (
  action_item_id    TEXT PRIMARY KEY,
  workflow_run_id   TEXT NOT NULL,
  step_index        INTEGER NOT NULL,                 -- 在 taskChain 数组里的下标; -1 表示 initialTask
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
```

### 7.4 任务链触发窗口
只在 ActionItem 从 `in_progress` → `done` 时触发下一步；`rejected / timeout / cancelled` 默认中断链（可后续做重试策略）。

---

## §8 和现有系统的交互矩阵

| 子系统 | 交互点 | 说明 |
|---|---|---|
| `mcp-primary` | 新增 `list_workflows` / `launch_workflow` 两个工具 | 转发 HTTP，不重实现 |
| `action-item` | 展开阶段批量 `createItem`；任务链阶段订阅 `action_item.resolved` | 不改现有 repo/types |
| `comm` / `send_msg` | taskChain 触发时复用 `runSendMsg` 派消息 | 不改底层 |
| `teams` / `role-instances` | launch 内部按序调 POST，依赖现有 bus 事件级联 | 已有 subscribers 自动联动（member-driver.start / roster.add / team.created WS） |
| Ticker | 不新增任务类型；ActionItem 的 reminder/timeout 本就走 Ticker | 零改动 |
| WS 事件白名单 | 新增 `workflow.launched` / `workflow.step_advanced` / `workflow.completed` 三事件 | 前端 teamCanvas 可选订阅，用于"项目进度" UI |
| bus 事件白名单 | 同上三事件注册到 `ws/event-types.ts` | 照 W1-7+8 pattern |
| 前端 | 新 `/workflows` 页面（模板商店）+ teamCanvas 显示项目来源 | 组件库现有 Card/TabFilter 可复用 |

---

## §9 用户接受度设计

### 9.1 心理建模
用户心里有**三层能力预期**：
1. **懒人模式**（80% 场景）：选一个"项目模板"，填目标，开跑。
2. **微调模式**（15%）：选模板 → 换一两个成员名字 / 调 deadline。
3. **专家模式**（5%）：自定义模板沉淀自己的团队套路。

**产品不应教育用户，要匹配用户的心理默认值。** 90% 的用户看到"代码审查 / 全栈开发 / Bug 修复"的卡片会秒懂，不需要解释 role/instance/team 的区别。

### 9.2 UI 建议（供前端后续细化）
**模板商店页面**：
- 卡片网格：每张卡片显示 icon + label + description + 成员头像堆叠（最多 4 个）。
- 一句话 metric："3 人协作 · 约 2 小时交付"。
- 主按钮：**"开项目"**（不叫"启动模板"）。
- 次按钮：**"查看详情"**（点开显示成员列表 + 任务链流程图）。

**开项目弹窗**（launch 前）：
- 项目名称（可选，默认 `${label}-${date}`）
- 目标（必填，textarea，占位符："例：审 PR #42，关注架构"）
- 截止时间（可选，预设 +1h / +2h / +今天下班 / 自定义）
- 成员名字（可选，展开高级选项才看得到）

**开项目后**：
- 自动关弹窗，跳 teamCanvas，提示一句 toast："已开团，主 Agent 正在协调"。
- teamCanvas 顶部显示项目名 + 来自哪个模板 + "进度 1/3"。

### 9.3 名词映射速查
| 内部用 | 用户面 |
|---|---|
| workflow template | 项目模板 / 团队方案 |
| launch | 开项目 / 起团 |
| role | 成员 |
| task chain | 协作流程 |
| action item | 任务 |
| custom workflow | 我的方案 |

---

## §10 实施任务拆解

### Wave 1 — 基础设施（并行 4 件）
- **W1-A**：DB migration —— `workflow_templates.sql` / `workflow_runs.sql` / `workflow_chain_bindings.sql` + SCHEMA_VERSION bump。单测覆盖迁移幂等。
- **W1-B**：类型层 —— `src/workflow/types.ts`（`WorkflowTemplate` / `WorkflowRun` / `ChainBinding`）。
- **W1-C**：Bus 事件 —— `bus/events.ts` 加 `workflow.launched` / `workflow.step_advanced` / `workflow.completed`；`ws/event-types.ts` 白名单。
- **W1-D**：内置模板 seed —— `src/domain/default-workflow-templates.ts` + `ensureDefaultWorkflowTemplates()` 幂等注入（对照 `default-templates.ts` pattern）。

### Wave 2 — 服务层（并行 3 件，依赖 W1）
- **W2-A**：Repo —— `src/workflow/template-repo.ts`（CRUD）+ `src/workflow/run-repo.ts`（run + chain binding）。
- **W2-B**：Service —— `src/workflow/service.ts`（`launch()` 核心：展开 + 回滚 + emit `workflow.launched`）。
- **W2-C**：WorkflowChainSubscriber —— `src/bus/subscribers/workflow-chain.subscriber.ts`（订阅 `action_item.resolved`，触发下一步 + emit `workflow.step_advanced` / `workflow.completed`）。

### Wave 3 — HTTP + MCP（依赖 W2）
- **W3-A**：HTTP panel handler —— `src/api/panel/workflows.ts`（5 个 handler + JSON 校验）+ `src/http/routes/workflows.routes.ts` 接线。单测覆盖 CRUD + launch + 回滚路径。
- **W3-B**：MCP 工具 —— `src/mcp-primary/tools/list_workflows.ts` + `launch_workflow.ts`，注册进 `registry.ts`。单测覆盖转发链路 + 占位符渲染。

### Wave 4 — 前端（依赖 W3，可在 W3 交付接口后并行）
- **W4-A**：模板商店页 —— `/workflows` 路由 + `WorkflowList` organism + `WorkflowCard` molecule。
- **W4-B**：开项目弹窗 —— `LaunchWorkflowDialog`。
- **W4-C**：teamCanvas 顶部项目进度条（读 `workflow.step_advanced` 事件）。

### Wave 5 — E2E 验收
- launch code-review → 确认 2 个实例 + 1 个团队 + 2 个 ActionItem 落库。
- leader 完成第一项 → WorkflowChain 触发 → tester 收到 task 消息 + 新 ActionItem。
- tester 完成 → `workflow.completed` 事件发出。
- teamCanvas 前端闭环截图。
- 回滚路径：故意让第 3 个 instance 失败，前 2 个应被清理。

### 文件行数预算
| 模块 | 文件数 | 总行数估算 |
|---|---|---|
| workflow 类型 | 1 | ~80 |
| workflow repo | 2 | ~220 |
| workflow service | 1 | ~180 |
| WorkflowChainSubscriber | 1 | ~120 |
| HTTP handler + route | 2 | ~200 |
| MCP 工具 | 2 | ~140 |
| DB schemas | 3 | ~60 |
| 内置模板 seed | 1 | ~180 |
| 前端组件 | 3 | ~400 |
| 单测 | 8 | ~900 |
| **合计** | **24** | **~2480** |

---

## §11 风险与取舍

| 风险 | 应对 |
|---|---|
| taskChain 过于僵化（只支持线性） | 明确本期不做 DAG；future work 可加 `dependsOn: string[]`。 |
| launch 中途失败难回滚 | try/catch + force-delete 已创建项；接受"小窗口不一致" 不做分布式事务。 |
| 占位符注入攻击（`{{...}}`） | 只在 server 端渲染，禁止在 goal/task 里嵌入 `{{system}}` / `{{env.*}}` 等；仅白名单 `goal` / `deadline` / `projectName`。 |
| 用户误删内置模板 | builtin=1 的模板 PUT/DELETE 一律 403。 |
| 自定义模板引用的角色模板被删 | launch 时实时校验，失败返回 400 + 明确错误；不做级联。 |
| 前端模板商店体验太重 | 首版只做列表 + 启动；自定义/编辑放后续。 |

---

## §12 决议清单

| # | 决策 | 理由 |
|---|---|---|
| D1 | 方案 C：HTTP 做 CRUD/查询，MCP 做 launch | HTTP 轻量 + MCP 保主 Agent 知情 |
| D2 | launch_workflow MCP 转发 HTTP，不重实现 | 单一事实源；对齐 create_leader pattern |
| D3 | 任务链只支持线性 `on_complete` / `on_resolve` | 本期简单够用；DAG 放后续 |
| D4 | 用户不暴露"工作流模板"词汇，对外叫"项目模板" | 降低理解门槛 |
| D5 | 内置 5 个模板起步（code-review / fullstack-feature / bug-fix / tech-research / docs-writing） | 覆盖日常 80% 协作场景 |
| D6 | 新增 workflow_runs + chain_bindings 两张表 | 追溯 + 触发下一步需要持久化 |
| D7 | 占位符白名单：goal / deadline / projectName | 安全 + 简单 |
| D8 | WorkflowChainSubscriber 订阅 `action_item.resolved` 驱动链条 | 复用现成事件，不新增 publisher |

---

## §13 交付口径

**本期完成 = 用户在对话里说"帮我起一个代码审查小组"，主 Agent 能匹配到 `code-review` 模板，调 `launch_workflow`，前端 teamCanvas 自动唤起显示 2 个成员卡片，leader 的 ActionItem 在 Ticker 里注册 reminder；leader 主动 resolve 后 tester 立即收到任务消息并生成第二条 ActionItem。**

证据要求：
- 单测 ≥80% 覆盖 service + chain subscriber 核心路径。
- 1 段 E2E 测试：真实 HTTP + 真实 bus + :memory: SQLite 跑通 launch → resolve → chain 触发。
- 前端 CDP 截图：模板卡片列表 + launch 弹窗 + teamCanvas 进度条三张。

---

**文档状态**：DRAFT v1，待 team-lead 和用户评审后冻结。
