// role-instance 的 prepared statements：单独抽出以控制 role-instance.ts 文件体积。
// 全部走 lazy init，closeDb 时通过 registerCloseHook 清空，下次 getDb 重新 prepare。

import type { Statement } from 'bun:sqlite';
import { getDb, registerCloseHook } from '../db/connection.js';

let insertRow: Statement | null = null;
let insertCreateEvent: Statement | null = null;
let findById: Statement | null = null;
let listAll: Statement | null = null;
let updateSession: Statement | null = null;
let updateStatus: Statement | null = null;
let insertTransitionEvent: Statement | null = null;
let insertDeleteEvent: Statement | null = null;
let deleteRow: Statement | null = null;

registerCloseHook(() => {
  insertRow = null;
  insertCreateEvent = null;
  findById = null;
  listAll = null;
  updateSession = null;
  updateStatus = null;
  insertTransitionEvent = null;
  insertDeleteEvent = null;
  deleteRow = null;
});

export const stmt = {
  insertRow(): Statement {
    return (insertRow ??= getDb().prepare(
      `INSERT INTO role_instances
         (id, template_name, member_name, is_leader, team_id, project_id,
          status, session_id, session_pid, leader_name, task, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?, ?, ?)`,
    ));
  },
  insertCreateEvent(): Statement {
    return (insertCreateEvent ??= getDb().prepare(
      `INSERT INTO role_state_events (instance_id, from_state, to_state, event, actor, at)
       VALUES (?, NULL, 'PENDING', 'create', NULL, ?)`,
    ));
  },
  findById(): Statement {
    return (findById ??= getDb().prepare(`SELECT * FROM role_instances WHERE id = ?`));
  },
  listAll(): Statement {
    return (listAll ??= getDb().prepare(
      `SELECT * FROM role_instances ORDER BY created_at DESC`,
    ));
  },
  updateSession(): Statement {
    return (updateSession ??= getDb().prepare(
      `UPDATE role_instances SET session_id = ?, session_pid = ?, status = ? WHERE id = ?`,
    ));
  },
  updateStatus(): Statement {
    return (updateStatus ??= getDb().prepare(
      `UPDATE role_instances SET status = ? WHERE id = ?`,
    ));
  },
  insertTransitionEvent(): Statement {
    return (insertTransitionEvent ??= getDb().prepare(
      `INSERT INTO role_state_events (instance_id, from_state, to_state, event, actor, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ));
  },
  insertDeleteEvent(): Statement {
    return (insertDeleteEvent ??= getDb().prepare(
      `INSERT INTO role_state_events (instance_id, from_state, to_state, event, actor, at)
       VALUES (?, ?, 'DELETED', 'delete', NULL, ?)`,
    ));
  },
  deleteRow(): Statement {
    return (deleteRow ??= getDb().prepare(`DELETE FROM role_instances WHERE id = ?`));
  },
};
