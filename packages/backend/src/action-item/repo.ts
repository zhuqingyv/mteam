// Phase 4 · ActionItem DAO。lazy prepare + registerCloseHook；纯 DB 访问不 emit 事件。
// DB snake_case ↔ JS camelCase 由 rowToJson 映射。详见 INTERFACE-CONTRACTS C-2。
import { randomUUID } from 'node:crypto';
import type { Statement } from 'bun:sqlite';
import { getDb, registerCloseHook } from '../db/connection.js';
import type {
  ActionItemKind, ActionItemRow, ActionItemStatus, ActorId, CreateActionItemInput,
} from './types.js';

interface Row {
  id: string; kind: ActionItemKind; title: string; description: string;
  creator_kind: ActorId['kind']; creator_id: string;
  assignee_kind: ActorId['kind']; assignee_id: string;
  deadline: number; status: ActionItemStatus;
  created_at: number; updated_at: number; reminded_at: number | null;
  resolution: string | null; team_id: string | null; related_message_uuid: string | null;
}

let insertStmt: Statement | null = null;
let findByIdStmt: Statement | null = null;
let updateStatusStmt: Statement | null = null;
let markRemindedStmt: Statement | null = null;
let listPendingStmt: Statement | null = null;
let listOverdueStmt: Statement | null = null;
let listApproachingStmt: Statement | null = null;
const listCache = new Map<string, Statement>();

registerCloseHook(() => {
  insertStmt = findByIdStmt = updateStatusStmt = markRemindedStmt = listPendingStmt = listOverdueStmt = listApproachingStmt = null;
  listCache.clear();
});

function rowToJson(r: Row): ActionItemRow {
  return {
    id: r.id, kind: r.kind, title: r.title, description: r.description,
    creator: { kind: r.creator_kind, id: r.creator_id },
    assignee: { kind: r.assignee_kind, id: r.assignee_id },
    deadline: r.deadline, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at, remindedAt: r.reminded_at,
    resolution: r.resolution, teamId: r.team_id, relatedMessageId: r.related_message_uuid,
  };
}

// 按列 + 可选 status 的动态 prepare 缓存。
function listBy(column: 'assignee_id' | 'creator_id', value: string, status?: ActionItemStatus): ActionItemRow[] {
  const key = `${column}:${status ?? '*'}`;
  let stmt = listCache.get(key);
  if (!stmt) {
    const tail = status ? 'AND status = ? ' : '';
    stmt = getDb().prepare(`SELECT * FROM action_items WHERE ${column} = ? ${tail}ORDER BY deadline ASC`);
    listCache.set(key, stmt);
  }
  const rows = (status ? stmt.all(value, status) : stmt.all(value)) as Row[];
  return rows.map(rowToJson);
}

export function createItem(input: CreateActionItemInput): ActionItemRow {
  const id = input.id ?? randomUUID();
  const now = Date.now();
  insertStmt ??= getDb().prepare(
    `INSERT OR IGNORE INTO action_items
      (id, kind, title, description, creator_kind, creator_id, assignee_kind, assignee_id,
       deadline, status, created_at, updated_at, reminded_at, resolution, team_id, related_message_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, ?, ?)`,
  );
  insertStmt.run(
    id, input.kind, input.title, input.description ?? '',
    input.creator.kind, input.creator.id, input.assignee.kind, input.assignee.id,
    input.deadline, now, now,
    input.teamId ?? null, input.relatedMessageId ?? null,
  );
  const row = findById(id);
  if (!row) throw new Error(`action_items insert failed: ${id}`);
  return row;
}

export function findById(id: string): ActionItemRow | null {
  findByIdStmt ??= getDb().prepare(`SELECT * FROM action_items WHERE id = ?`);
  const row = findByIdStmt.get(id) as Row | undefined;
  return row ? rowToJson(row) : null;
}

export function listByAssignee(assigneeId: string, status?: ActionItemStatus): ActionItemRow[] {
  return listBy('assignee_id', assigneeId, status);
}

export function listByCreator(creatorId: string, status?: ActionItemStatus): ActionItemRow[] {
  return listBy('creator_id', creatorId, status);
}

export function listPending(): ActionItemRow[] {
  listPendingStmt ??= getDb().prepare(
    `SELECT * FROM action_items WHERE status IN ('pending','in_progress') ORDER BY deadline ASC`,
  );
  return (listPendingStmt.all() as Row[]).map(rowToJson);
}

export function updateStatus(id: string, status: ActionItemStatus): ActionItemRow | null {
  updateStatusStmt ??= getDb().prepare(
    `UPDATE action_items SET status = ?, updated_at = ? WHERE id = ?`,
  );
  const info = updateStatusStmt.run(status, Date.now(), id);
  return info.changes ? findById(id) : null;
}

// resolve: done / rejected。updatedAt 即 "resolved at"。
export function resolve(id: string, status: 'done' | 'rejected'): ActionItemRow | null {
  return updateStatus(id, status);
}

export function timeout(id: string): ActionItemRow | null {
  return updateStatus(id, 'timeout');
}

// scheduler reminder 路径写入；不改 status、不 bump updated_at（语义上"提醒"不是状态变更）。
export function markReminded(id: string, at: number): ActionItemRow | null {
  markRemindedStmt ??= getDb().prepare(
    `UPDATE action_items SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL`,
  );
  const info = markRemindedStmt.run(at, id);
  return info.changes ? findById(id) : null;
}

export function listOverdue(now: number): ActionItemRow[] {
  listOverdueStmt ??= getDb().prepare(
    `SELECT * FROM action_items WHERE status IN ('pending','in_progress') AND deadline < ? ORDER BY deadline ASC`,
  );
  return (listOverdueStmt.all(now) as Row[]).map(rowToJson);
}

// 剩余比例 <= thresholdRatio 且 reminded_at 仍为 NULL；deadline 已过留给 listOverdue。
export function listApproachingDeadline(now: number, thresholdRatio: number): ActionItemRow[] {
  listApproachingStmt ??= getDb().prepare(
    `SELECT * FROM action_items
      WHERE status IN ('pending','in_progress')
        AND reminded_at IS NULL
        AND deadline >= ?
        AND (deadline - ?) <= (deadline - created_at) * ?
      ORDER BY deadline ASC`,
  );
  return (listApproachingStmt.all(now, now, thresholdRatio) as Row[]).map(rowToJson);
}
