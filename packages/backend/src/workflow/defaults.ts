// Phase 5 · 5 个内置工作流模板 seed。启动时幂等注入（INSERT OR IGNORE）。
// 引用的角色模板必须已存在；default-templates.ts 已注入 11 个内置角色。
import { getDb } from '../db/connection.js';
import type { TaskChainStep, WorkflowRole } from './types.js';

interface DefaultWorkflow {
  name: string;
  label: string;
  description: string;
  icon: string;
  roles: WorkflowRole[];
  taskChain: TaskChainStep[];
}

const chain = (from: string, to: string, task: string): TaskChainStep =>
  ({ from, to, trigger: 'on_complete', task });

const DEFAULT_WORKFLOWS: DefaultWorkflow[] = [
  {
    name: 'code-review', label: '代码审查', icon: 'avatar-06',
    description: '审查员主审 + 测试员回归；适合 PR/MR 场景',
    roles: [
      { templateName: 'code-reviewer', isLeader: true, task: '审查 {{goal}}，关注架构与边界条件。' },
      { templateName: 'qa-engineer', isLeader: false },
    ],
    taskChain: [chain('code-reviewer', 'qa-engineer', 'reviewer 已完成审查，请对 {{goal}} 跑回归测试用例。')],
  },
  {
    name: 'fullstack-team', label: '全栈开发', icon: 'avatar-01',
    description: '前端主导 + 后端配合 + QA 验收；适合端到端 feature',
    roles: [
      { templateName: 'frontend-dev', isLeader: true, task: '拆解 {{goal}} 的 UI 和 API 契约。' },
      { templateName: 'backend-dev', isLeader: false },
      { templateName: 'qa-engineer', isLeader: false },
    ],
    taskChain: [
      chain('frontend-dev', 'backend-dev', 'frontend 已拆解需求，请按契约实现 {{goal}} 的后端接口。'),
      chain('backend-dev', 'qa-engineer', 'backend 已交付，请对 {{goal}} 做端到端验收。'),
    ],
  },
  {
    name: 'bug-fix', label: 'Bug 修复', icon: 'avatar-02',
    description: '开发定位修复 + QA 验证复现；适合线上 bug',
    roles: [
      { templateName: 'backend-dev', isLeader: true, task: '定位并修复 {{goal}}。' },
      { templateName: 'qa-engineer', isLeader: false },
    ],
    taskChain: [chain('backend-dev', 'qa-engineer', '修复已提交，请验证 {{goal}} 的问题不再复现。')],
  },
  {
    name: 'tech-research', label: '技术调研', icon: 'avatar-05',
    description: '架构师出方案 + 后端 POC 验证；适合技术选型',
    roles: [
      { templateName: 'tech-architect', isLeader: true, task: '针对 {{goal}} 产出技术方案，列出选项与权衡。' },
      { templateName: 'backend-dev', isLeader: false },
    ],
    taskChain: [chain('tech-architect', 'backend-dev', '方案已产出，请做 POC 验证 {{goal}} 的关键路径。')],
  },
  {
    name: 'doc-writing', label: '文档编写', icon: 'avatar-09',
    description: '技术写手初稿 + 审查员校验；适合 API/教程文档',
    roles: [
      { templateName: 'tech-writer', isLeader: true, task: '撰写 {{goal}} 的初稿。' },
      { templateName: 'code-reviewer', isLeader: false },
    ],
    taskChain: [chain('tech-writer', 'code-reviewer', '初稿已完成，请审阅 {{goal}} 的准确性与可读性。')],
  },
];

export function ensureDefaultWorkflows(): void {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO workflow_templates
       (name, label, description, icon, roles, task_chain, builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const w of DEFAULT_WORKFLOWS) {
      stmt.run(
        w.name, w.label, w.description, w.icon,
        JSON.stringify(w.roles), JSON.stringify(w.taskChain),
        now, now,
      );
    }
  });
  tx();
}

export const DEFAULT_WORKFLOW_COUNT = DEFAULT_WORKFLOWS.length;
