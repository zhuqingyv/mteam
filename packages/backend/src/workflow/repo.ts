// Phase 5 · workflow_templates DAO。lazy prepare + registerCloseHook。
// JSON 字段 roles / task_chain 在此层做 parse/stringify。
import type { Statement } from 'bun:sqlite';
import { getDb, registerCloseHook } from '../db/connection.js';
import type {
  CreateWorkflowInput, TaskChainStep, WorkflowRole, WorkflowTemplate,
} from './types.js';

interface Row {
  name: string;
  label: string;
  description: string | null;
  icon: string | null;
  roles: string;
  task_chain: string;
  builtin: number;
  created_at: string;
  updated_at: string;
}

let insertStmt: Statement | null = null;
let findByNameStmt: Statement | null = null;
let listAllStmt: Statement | null = null;
let deleteStmt: Statement | null = null;

registerCloseHook(() => {
  insertStmt = findByNameStmt = listAllStmt = deleteStmt = null;
});

function rowToJson(r: Row): WorkflowTemplate {
  return {
    name: r.name,
    label: r.label,
    description: r.description,
    icon: r.icon,
    roles: JSON.parse(r.roles) as WorkflowRole[],
    taskChain: JSON.parse(r.task_chain) as TaskChainStep[],
    builtin: r.builtin === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createWorkflow(input: CreateWorkflowInput): WorkflowTemplate {
  const now = new Date().toISOString();
  insertStmt ??= getDb().prepare(
    `INSERT INTO workflow_templates
       (name, label, description, icon, roles, task_chain, builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertStmt.run(
    input.name,
    input.label,
    input.description ?? null,
    input.icon ?? null,
    JSON.stringify(input.roles),
    JSON.stringify(input.taskChain ?? []),
    input.builtin ? 1 : 0,
    now,
    now,
  );
  const row = findByName(input.name);
  if (!row) throw new Error(`workflow_templates insert failed: ${input.name}`);
  return row;
}

export function findByName(name: string): WorkflowTemplate | null {
  findByNameStmt ??= getDb().prepare(`SELECT * FROM workflow_templates WHERE name = ?`);
  const row = findByNameStmt.get(name) as Row | undefined;
  return row ? rowToJson(row) : null;
}

export function listAll(): WorkflowTemplate[] {
  listAllStmt ??= getDb().prepare(
    `SELECT * FROM workflow_templates ORDER BY builtin DESC, name ASC`,
  );
  return (listAllStmt.all() as Row[]).map(rowToJson);
}

// 内置模板拒删；不存在返回静默（让调用方先 findByName 判断）。
export function deleteWorkflow(name: string): void {
  const existing = findByName(name);
  if (!existing) return;
  if (existing.builtin) {
    throw new Error(`workflow '${name}' is builtin and cannot be deleted`);
  }
  deleteStmt ??= getDb().prepare(`DELETE FROM workflow_templates WHERE name = ?`);
  deleteStmt.run(name);
}
