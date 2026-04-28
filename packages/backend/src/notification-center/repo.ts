// Phase 5 · notifications DAO。lazy prepare + registerCloseHook；纯 DB 访问不 emit 事件。
// 设计：docs/phase5/notification-system-design.md §2.6
import { randomUUID } from 'node:crypto';
import type { Statement } from 'bun:sqlite';
import { getDb, registerCloseHook } from '../db/connection.js';
import type {
  NotificationChannel, NotificationKind, NotificationRecord, Severity,
} from './types.js';

interface Row {
  id: string; user_id: string | null; kind: string; channel: string;
  severity: string; title: string; body: string; payload: string;
  source_event_type: string | null; source_event_id: string | null;
  acknowledged_at: string | null; created_at: string;
}

let pushStmt: Statement | null = null;
let findByIdStmt: Statement | null = null;
let listAllStmt: Statement | null = null;
let listUnreadStmt: Statement | null = null;
let countUnreadStmt: Statement | null = null;
let ackStmt: Statement | null = null;
let ackAllStmt: Statement | null = null;

registerCloseHook(() => {
  pushStmt = findByIdStmt = listAllStmt = listUnreadStmt = null;
  countUnreadStmt = ackStmt = ackAllStmt = null;
});

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch { /* 脏数据兜底 */ }
  return {};
}

function rowToRecord(r: Row): NotificationRecord {
  return {
    id: r.id, userId: r.user_id,
    kind: r.kind as NotificationKind,
    channel: r.channel as NotificationChannel,
    severity: r.severity as Severity,
    title: r.title, body: r.body, payload: parsePayload(r.payload),
    ...(r.source_event_type ? { sourceEventType: r.source_event_type } : {}),
    ...(r.source_event_id ? { sourceEventId: r.source_event_id } : {}),
    acknowledgedAt: r.acknowledged_at, createdAt: r.created_at,
  };
}

export function pushNotification(
  input: Omit<NotificationRecord, 'id' | 'createdAt' | 'acknowledgedAt'>,
): NotificationRecord {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  pushStmt ??= getDb().prepare(
    `INSERT INTO notifications
       (id, user_id, kind, channel, severity, title, body, payload,
        source_event_type, source_event_id, acknowledged_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  pushStmt.run(
    id, input.userId, input.kind, input.channel, input.severity,
    input.title, input.body, JSON.stringify(input.payload ?? {}),
    input.sourceEventType ?? null, input.sourceEventId ?? null, createdAt,
  );
  const row = findById(id);
  if (!row) throw new Error(`notifications insert failed: ${id}`);
  return row;
}

export function findById(id: string): NotificationRecord | null {
  findByIdStmt ??= getDb().prepare(`SELECT * FROM notifications WHERE id = ?`);
  const row = findByIdStmt.get(id) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

// userId 传 null 匹配 default 用户行（WHERE user_id IS NULL）；非 null 精确匹配。
// 对外签名用 string 对齐 leader 契约；内部兼容 null 由上游自行处理 default。
export function listByUser(
  userId: string | null,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): NotificationRecord[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  if (opts.unreadOnly) {
    listUnreadStmt ??= getDb().prepare(
      `SELECT * FROM notifications WHERE user_id IS ? AND acknowledged_at IS NULL
        ORDER BY created_at DESC LIMIT ?`,
    );
    return (listUnreadStmt.all(userId, limit) as Row[]).map(rowToRecord);
  }
  listAllStmt ??= getDb().prepare(
    `SELECT * FROM notifications WHERE user_id IS ? ORDER BY created_at DESC LIMIT ?`,
  );
  return (listAllStmt.all(userId, limit) as Row[]).map(rowToRecord);
}

export function countUnread(userId: string | null): number {
  countUnreadStmt ??= getDb().prepare(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id IS ? AND acknowledged_at IS NULL`,
  );
  const row = countUnreadStmt.get(userId) as { n: number } | undefined;
  return row?.n ?? 0;
}

// 幂等：已 ack 再 ack 不覆盖 acknowledged_at，返回当前记录。
export function acknowledge(id: string): NotificationRecord | null {
  ackStmt ??= getDb().prepare(
    `UPDATE notifications SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`,
  );
  ackStmt.run(new Date().toISOString(), id);
  return findById(id);
}

export function acknowledgeAll(userId: string | null): number {
  ackAllStmt ??= getDb().prepare(
    `UPDATE notifications SET acknowledged_at = ? WHERE user_id IS ? AND acknowledged_at IS NULL`,
  );
  const info = ackAllStmt.run(new Date().toISOString(), userId);
  return Number(info.changes ?? 0);
}
