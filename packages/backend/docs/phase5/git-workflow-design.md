# Git 工作规范可选注入设计

> 日期：2026-04-28
> 状态：设计稿，待用户确认后开发

---

## 1. 需求总结

- 一段通用 git 工作规范 prompt 文本，不分 leader/成员版
- 创建 leader/成员实例时有开关 `enableGitWorkflow`
- 开了 → 拼到 agent 的 systemPrompt 里；没开 → 不注入
- leader 开了 → 它创建的成员自动继承
- 文本存 Settings Registry（`system.gitWorkflowPrompt`），用户可改
- 实例级配置，不是模板级 — 同一模板在不同项目可以开或不开
- 后期主 Agent 通过 `search_settings` / `call_setting` 可搜到和修改

---

## 2. 默认 prompt 文本

```
## Git 工作规范
- Leader 负责确认和管理主分支（main/master/develop 等）
- 成员开始任务前先确认主分支，从主分支用 git worktree 创建独立分支开发
- 分支命名：<角色名>/<任务简述>（如 frontend-dev/login-page）
- 所有 commit 必须带 Co-Authored-By: <你的角色名> <角色名@mteam.local>
- 开发完成后提 PR，不直接 push 主分支
- PR 标题写清楚做了什么，描述里列改动点
- 代码合并前必须有 review
```

---

## 3. 数据模型

### 3.1 role_instances 加字段

```sql
ALTER TABLE role_instances ADD COLUMN git_workflow INTEGER NOT NULL DEFAULT 0;
```

- `0` = 不注入 git 规范
- `1` = 注入 git 规范

### 3.2 system_configs 加默认文本

```sql
INSERT OR IGNORE INTO system_configs (key, value_json, updated_at)
VALUES ('system.gitWorkflowPrompt', '"## Git 工作规范\n- Leader 负责确认和管理主分支..."', '<now>');
```

### 3.3 Settings Registry 注册

```ts
// settings/entries/system.ts 新增
{
  key: 'system.gitWorkflowPrompt',
  label: 'Git 工作规范提示词',
  description: '注入到 agent systemPrompt 的 git 工作规范文本，用户可自定义',
  category: 'system',
  schema: { type: 'string' },
  readonly: false,
  notify: 'none',
  getter: () => readSystemConfig('system.gitWorkflowPrompt') ?? DEFAULT_GIT_WORKFLOW_PROMPT,
  setter: (v) => writeSystemConfig('system.gitWorkflowPrompt', v),
}
```

---

## 4. 注入逻辑

### 4.1 driver-config.ts

```ts
// buildDriverConfig / buildMemberDriverConfig 里：
const basePrompt = row.systemPrompt ?? '';
const gitBlock = row.gitWorkflow ? readGitWorkflowPrompt() : '';
const systemPrompt = gitBlock ? basePrompt + '\n\n' + gitBlock : basePrompt;
```

`readGitWorkflowPrompt()` 从 system_configs 读，缺省用默认文本。

### 4.2 成员继承

leader 创建成员时（`add_member` / member-driver lifecycle）：
```ts
const memberGitWorkflow = leader.gitWorkflow; // 继承 leader 的值
```

成员不需要单独设，跟 leader 走。

---

## 5. 接口改动

### 5.1 create_leader MCP schema 扩展

```ts
inputSchema: {
  // ...现有字段
  enableGitWorkflow: { type: 'boolean', description: '是否启用 git 工作规范注入' },
}
```

### 5.2 POST /api/role-instances

body 加可选字段：
```ts
{ gitWorkflow?: boolean }
```

### 5.3 add_member（mteam MCP）

内部自动读 leader 的 `git_workflow` 值，成员继承。接口不暴露 `enableGitWorkflow` 参数。

---

## 6. 与 Settings Registry 的关系

- `system.gitWorkflowPrompt` 注册到 Settings Registry
- 主 Agent 可 `search_settings({q:'git'})` 搜到
- 可 `call_setting({key:'system.gitWorkflowPrompt', mode:'show'})` 弹给用户改
- 也可 `call_setting({key:'system.gitWorkflowPrompt', mode:'direct', value:'...'})` 直接改

---

## 7. 文件变更清单

| 文件 | 改动 |
|------|------|
| `db/schemas/role_instances.sql` | 加 `git_workflow` 列 |
| `db/migrations/2026-04-28-git-workflow.ts` | ALTER TABLE 幂等 |
| `domain/role-instance.ts` | RoleInstance 加 `gitWorkflow` 字段 |
| `primary-agent/driver-config.ts` | systemPrompt 拼接 git 规范 |
| `member-agent/driver-config.ts`（如果有） | 同上 |
| `mcp-primary/tools/create_leader.ts` | schema 加 `enableGitWorkflow` |
| `settings/entries/system.ts` | 加 `system.gitWorkflowPrompt` entry |
| `system/quota-config.ts`（或新文件） | `readGitWorkflowPrompt()` 函数 |
| `bus/subscribers/member-driver/lifecycle.ts` | 成员继承 leader.gitWorkflow |

---

## 8. 实施任务拆解

| # | 任务 | 依赖 | 估时 |
|---|------|------|------|
| T1 | migration + role_instances 加字段 | 无 | 小 |
| T2 | system.gitWorkflowPrompt Settings entry | T1 | 小 |
| T3 | driver-config.ts 注入逻辑 | T1+T2 | 小 |
| T4 | create_leader schema 扩展 | T1 | 小 |
| T5 | 成员继承 leader.gitWorkflow | T1 | 小 |
| T6 | 测试 | T1-T5 | 中 |

T1/T2/T4 可并行。
