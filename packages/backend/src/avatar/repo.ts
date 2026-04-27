import type { Statement } from 'bun:sqlite';
import { getDb, registerCloseHook } from '../db/connection.js';
import type { AvatarRow } from './types.js';

interface Row {
  id: string;
  filename: string;
  builtin: number;
  hidden: number;
  created_at: string;
}

let listVisibleStmt: Statement | null = null;
let listAllStmt: Statement | null = null;
let insertStmt: Statement | null = null;
let findByIdStmt: Statement | null = null;
let hideBuiltinStmt: Statement | null = null;
let deleteCustomStmt: Statement | null = null;
let restoreStmt: Statement | null = null;
let randomVisibleStmt: Statement | null = null;

registerCloseHook(() => {
  listVisibleStmt = null;
  listAllStmt = null;
  insertStmt = null;
  findByIdStmt = null;
  hideBuiltinStmt = null;
  deleteCustomStmt = null;
  restoreStmt = null;
  randomVisibleStmt = null;
});

function rowToJson(row: Row): AvatarRow {
  return {
    id: row.id,
    filename: row.filename,
    builtin: row.builtin === 1,
    hidden: row.hidden === 1,
    createdAt: row.created_at,
  };
}

export function listVisible(): AvatarRow[] {
  listVisibleStmt ??= getDb().prepare(
    `SELECT * FROM avatars WHERE hidden = 0 ORDER BY builtin DESC, created_at ASC, id ASC`,
  );
  return (listVisibleStmt.all() as Row[]).map(rowToJson);
}

export function listAll(): AvatarRow[] {
  listAllStmt ??= getDb().prepare(
    `SELECT * FROM avatars ORDER BY builtin DESC, created_at ASC, id ASC`,
  );
  return (listAllStmt.all() as Row[]).map(rowToJson);
}

export function findById(id: string): AvatarRow | null {
  findByIdStmt ??= getDb().prepare(`SELECT * FROM avatars WHERE id = ?`);
  const row = findByIdStmt.get(id) as Row | undefined;
  return row ? rowToJson(row) : null;
}

export function addCustom(id: string, filename: string): AvatarRow {
  insertStmt ??= getDb().prepare(
    `INSERT INTO avatars (id, filename, builtin, hidden, created_at) VALUES (?, ?, 0, 0, ?)`,
  );
  insertStmt.run(id, filename, new Date().toISOString());
  const row = findById(id);
  if (!row) throw new Error(`avatar insert failed: ${id}`);
  return row;
}

// 内置 → hidden=1（保留，可还原）；自定义 → 真删。
export function remove(id: string): void {
  const row = findById(id);
  if (!row) return;
  if (row.builtin) {
    hideBuiltinStmt ??= getDb().prepare(`UPDATE avatars SET hidden = 1 WHERE id = ?`);
    hideBuiltinStmt.run(id);
  } else {
    deleteCustomStmt ??= getDb().prepare(`DELETE FROM avatars WHERE id = ?`);
    deleteCustomStmt.run(id);
  }
}

// 恢复所有内置头像的 hidden=0；返回本次实际被恢复的数量。
export function restoreBuiltins(): number {
  restoreStmt ??= getDb().prepare(
    `UPDATE avatars SET hidden = 0 WHERE builtin = 1 AND hidden = 1`,
  );
  const info = restoreStmt.run();
  return Number(info.changes ?? 0);
}

export function randomOne(): AvatarRow | null {
  randomVisibleStmt ??= getDb().prepare(
    `SELECT * FROM avatars WHERE hidden = 0 ORDER BY RANDOM() LIMIT 1`,
  );
  const row = randomVisibleStmt.get() as Row | undefined;
  return row ? rowToJson(row) : null;
}
