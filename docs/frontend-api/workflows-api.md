# 工作流模板 API

> **面向**：前端 UI（工作流模板库 / 一键起项目向导）。
>
> **调用方**：前端通过 `/api/panel/workflows` 门面路径访问（门面整树转发到 `/api/workflows`）。后端写操作会 emit 现有的 `instance.created` / `team.created` / `team.member_joined` 等 bus 事件；workflow 自身**不单独**广播事件。

工作流模板（对外叫"项目模板"）= 一键生成 `leader + 成员 + 首批任务链` 的装机镜像。首批内置 5 个：`code-review` / `fullstack-team` / `bug-fix` / `tech-research` / `doc-writing`。内置模板 `builtin=true`，不可删。

源码：`packages/backend/src/http/routes/workflows.routes.ts` · `packages/backend/src/workflow/{types,repo,defaults}.ts`

## TS 类型

```ts
interface WorkflowRole {
  templateName: string;     // 引用已存在的角色模板名（roleTemplates.name）
  isLeader: boolean;        // 必须且仅有一个 true
  task?: string;            // 可选初始任务，支持 {{goal}} / {{projectName}} / {{deadline}} 插值
}

interface TaskChainStep {
  from: string;             // 上一步的 role templateName
  to: string;               // 下一步的 role templateName
  trigger: 'on_complete';   // 目前只支持一种触发
  task: string;             // 触发后给 `to` 派发的任务文本，同样支持插值
}

interface WorkflowTemplate {
  name: string;             // slug，匹配 ^[a-z][a-z0-9-]{1,63}$
  label: string;            // 展示名（中文 OK），≥1 字符
  description: string | null;
  icon: string | null;      // 头像 id，例如 "avatar-06"
  roles: WorkflowRole[];    // 非空数组，且恰好一个 isLeader=true
  taskChain: TaskChainStep[]; // 可空；线性链，on_complete 触发下一步
  builtin: boolean;         // 内置模板，不可删除
  createdAt: string;        // ISO
  updatedAt: string;
}

interface CreateWorkflowInput {
  name: string;
  label: string;
  description?: string | null;
  icon?: string | null;
  roles: WorkflowRole[];
  taskChain?: TaskChainStep[];
}

interface LaunchWorkflowInput {
  projectName: string;      // 必填，用作 team.name
  goal: string;             // 必填，替换 roles.task / taskChain.task 里的 {{goal}}
  deadline?: number;        // 可选时间戳（ms），替换 {{deadline}}；不传则插值为空串
}

interface LaunchWorkflowResponse {
  teamId: string;
  leaderId: string;
  members: Array<{ templateName: string; instanceId: string }>;
}
```

## `GET /api/panel/workflows`

列出全部工作流模板。`builtin DESC, name ASC` 排序，内置模板在前。

响应 `200`：`WorkflowTemplate[]`

```json
[
  {
    "name": "code-review",
    "label": "代码审查",
    "description": "审查员主审 + 测试员回归；适合 PR/MR 场景",
    "icon": "avatar-06",
    "roles": [
      { "templateName": "code-reviewer", "isLeader": true, "task": "审查 {{goal}}，关注架构与边界条件。" },
      { "templateName": "qa-engineer", "isLeader": false }
    ],
    "taskChain": [
      { "from": "code-reviewer", "to": "qa-engineer", "trigger": "on_complete", "task": "reviewer 已完成审查，请对 {{goal}} 跑回归测试用例。" }
    ],
    "builtin": true,
    "createdAt": "2026-04-20T00:00:00.000Z",
    "updatedAt": "2026-04-20T00:00:00.000Z"
  }
]
```

## `POST /api/panel/workflows`

创建自定义工作流模板。创建后 `builtin` 固定为 `false`（前端不必传）。

请求体：
```json
{
  "name": "ux-review",
  "label": "UX 评审",
  "description": "设计主导 + 前端验收",
  "icon": "avatar-03",
  "roles": [
    { "templateName": "product-manager", "isLeader": true, "task": "拆解 {{goal}} 的用户价值点。" },
    { "templateName": "frontend-dev", "isLeader": false }
  ],
  "taskChain": [
    { "from": "product-manager", "to": "frontend-dev", "trigger": "on_complete", "task": "PM 已拆分，请评估 {{goal}} 的前端改动范围。" }
  ]
}
```

响应 `201`：`WorkflowTemplate`

错误：
- `400 body must be a JSON object`
- `400 name must match ^[a-z][a-z0-9-]{1,63}$`
- `400 label is required`
- `400 roles must be a non-empty array`
- `400 each role must have templateName:string + isLeader:boolean`
- `400 roles must contain exactly one leader`（必须且仅有一个 `isLeader=true`）
- `409 workflow '<name>' already exists`

> 后端**不校验** `roles[].templateName` 是否指向已存在的角色模板，也不校验 `taskChain.from/to` 与 roles 列表对应 —— 如果前端允许用户选未注册模板，launch 时会在第一步 `POST /api/role-instances` 返回 `404 template '<name>' not found`。

## `POST /api/panel/workflows/:name/launch`

一键启动：按模板创建 leader 实例 → 创建 team → 逐个创建成员并挂到 team 上。**按顺序串行调底层 HTTP**（`/api/role-instances` 三次 + `/api/teams` 一次 + `/api/teams/:id/members` 一次），任何一步失败都会原样透传对应的 status 和 body，**已创建的实例/团队不会回滚**（前端需要在重试前清理残留，否则再次 launch 会命中 memberName 冲突）。

请求体：
```json
{
  "projectName": "支付对账 Bug 排查",
  "goal": "修复 2026-04-25 对账差异",
  "deadline": 1777660800000
}
```

插值规则：`roles[].task` 与 `taskChain[].task` 中的 `{{goal}}` / `{{projectName}}` / `{{deadline}}` 会被替换；`deadline` 未传时替换为空串，`{{deadline}}` 会变成 `""`。

响应 `201`：`LaunchWorkflowResponse`

```json
{
  "teamId": "team-xxxx",
  "leaderId": "inst-leader-xxxx",
  "members": [
    { "templateName": "qa-engineer", "instanceId": "inst-qa-xxxx" }
  ]
}
```

错误：
- `400 body must be a JSON object`
- `400 projectName is required`
- `400 goal is required`
- `404 workflow '<name>' not found`
- `500 workflow '<name>' has no leader role`（数据损坏兜底，理论不应发生）
- 底层透传错误（status + body 与 `/api/role-instances` / `/api/teams` 完全一致）：
  - 创建 leader / 成员实例时：`404 template '<templateName>' not found`、`409` 配额超限（body 含 `code/resource/current/limit`，见 [instances-api §409 配额超限](./instances-api.md) 与 [templates-and-mcp §错误码](./templates-and-mcp.md)）、`400` memberName 重复等
  - 创建 team 时：`409 team name '<projectName>' already exists`

## 副作用（bus 事件）

launch 过程中底层路由依然按原逻辑 emit 事件，前端**通过 WS 订阅 `global` 就能拿到**：

| 事件 | 何时发 | 载荷关键字段 |
|---|---|---|
| `instance.created`  | 每次创建 leader / 成员实例 | `instanceId` / `templateName` / `memberName` / `isLeader` / `teamId` / `task` |
| `team.created`      | leader 建好后创建 team     | `teamId` / `name` / `leaderInstanceId` |
| `team.member_joined`| 每个非 leader 成员挂到 team 上 | `teamId` / `instanceId` / `roleInTeam` |

> 工作流本身不单独发事件（例如没有 `workflow.launched`）。前端想显示"模板 X 已启动"时，按 launch 返回的 `teamId` 去订阅 `team:<teamId>` 即可收完整 member_joined 流。

## 不暴露/未落地

- **删除工作流模板**：DAO 已实现（`deleteWorkflow`，内置拒删），HTTP 路由**未挂载**。前端若需要，和后端对齐后再扩。
- **更新工作流模板**：无对应 DAO 与路由。当前约定自定义模板不可原地改，前端想改让用户删了重建即可（路由开放后）。
- **任务链实际触发**：`taskChain` 只是元数据，真正的 "on_complete → 派下一步" 链式执行由后端 `WorkflowChainSubscriber` 按 `action_item.resolved` 触发；前端不需要自己调度下一步任务。
