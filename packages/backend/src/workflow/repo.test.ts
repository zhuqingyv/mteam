// workflow/repo + defaults 单测 — 不 mock，:memory: 真跑 bun:sqlite。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { getDb, closeDb } from '../db/connection.js';
import { createWorkflow, findByName, listAll, deleteWorkflow } from './repo.js';
import { ensureDefaultWorkflows, DEFAULT_WORKFLOW_COUNT } from './defaults.js';
import type { CreateWorkflowInput } from './types.js';

function mk(o: Partial<CreateWorkflowInput> = {}): CreateWorkflowInput {
  return {
    name: 'custom-flow', label: '自定义流程', description: 'test', icon: 'avatar-99',
    roles: [
      { templateName: 'frontend-dev', isLeader: true, task: '前端任务' },
      { templateName: 'backend-dev', isLeader: false },
    ],
    taskChain: [{ from: 'frontend-dev', to: 'backend-dev', trigger: 'on_complete', task: '接力' }],
    ...o,
  };
}

beforeEach(() => { closeDb(); getDb(); });
afterAll(() => { closeDb(); });

describe('createWorkflow + findByName', () => {
  it('createWorkflow 返回完整 row；findByName 取回同样内容', () => {
    const row = createWorkflow(mk());
    expect(row.name).toBe('custom-flow');
    expect(row.builtin).toBe(false);
    expect(row.roles[0]).toEqual({ templateName: 'frontend-dev', isLeader: true, task: '前端任务' });
    expect(row.taskChain).toHaveLength(1);
    expect(row.createdAt).toBe(row.updatedAt);
    expect(findByName('custom-flow')).toEqual(row);
    expect(findByName('nope')).toBeNull();
  });

  it('默认值：description/icon 可为 null，taskChain 缺省为空数组', () => {
    const row = createWorkflow({
      name: 'minimal', label: '最小',
      roles: [{ templateName: 'frontend-dev', isLeader: true }],
    });
    expect(row.description).toBeNull();
    expect(row.icon).toBeNull();
    expect(row.taskChain).toEqual([]);
  });
});

describe('listAll', () => {
  it('内置模板在前（builtin DESC），自定义在后', () => {
    ensureDefaultWorkflows();
    createWorkflow(mk({ name: 'zz-custom' }));
    const rows = listAll();
    expect(rows).toHaveLength(DEFAULT_WORKFLOW_COUNT + 1);
    expect(rows[0].builtin).toBe(true);
    expect(rows[rows.length - 1].name).toBe('zz-custom');
  });
});

describe('deleteWorkflow', () => {
  it('删除自定义 → 成功；删除内置 → throw；删不存在 → 静默', () => {
    ensureDefaultWorkflows();
    createWorkflow(mk({ name: 'to-delete' }));
    deleteWorkflow('to-delete');
    expect(findByName('to-delete')).toBeNull();
    expect(() => deleteWorkflow('code-review')).toThrow(/builtin/);
    expect(findByName('code-review')).not.toBeNull();
    expect(() => deleteWorkflow('never-existed')).not.toThrow();
  });
});

describe('ensureDefaultWorkflows', () => {
  it('注入 5 个内置模板，每个恰好 1 个 leader', () => {
    ensureDefaultWorkflows();
    const rows = listAll();
    expect(rows.length).toBe(DEFAULT_WORKFLOW_COUNT);
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(['bug-fix', 'code-review', 'doc-writing', 'fullstack-team', 'tech-research']);
    for (const r of rows) {
      expect(r.builtin).toBe(true);
      expect(r.roles.filter((x) => x.isLeader)).toHaveLength(1);
    }
  });

  it('幂等：重复调用不重复插入', () => {
    ensureDefaultWorkflows();
    ensureDefaultWorkflows();
    ensureDefaultWorkflows();
    expect(listAll().length).toBe(DEFAULT_WORKFLOW_COUNT);
  });
});
