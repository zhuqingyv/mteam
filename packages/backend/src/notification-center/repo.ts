// Phase 5 · notifications DAO。lazy prepare + registerCloseHook；
// Phase 5 W2：push 落库后 emit bus notification.delivered，WS 再把它推到前端触发 OS 通知。
// 设计：docs/phase5/notification-system-design.md §2.6
import { randomUUID } from 'node:crypto';
import type { Statement } from 'bun:sqlite';
import { getDb, registerCloseHook } from '../db/connection.js';
import { bus } from '../bus/events.js';
import { makeBase } from '../bus/helpers.js';
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
  // W2：写库成功后广播事件；订阅 global 的 WS 连接会收到 → 前端触发 OS 通知。
  // 失败不回滚 DB（通知持久化优先于推送），err 吞到 stderr 防噪声。
  try {
    bus.emit({
      ...makeBase('notification.delivered', 'notification-center'),
      target: { kind: 'user', id: row.userId ?? 'local' },
      notificationId: row.id,
      kind: row.kind,
      channel: row.channel,
      severity: row.severity,
      title: row.title,
      body: row.body,
      payload: row.payload,
      ...(row.sourceEventType ? { sourceEventType: row.sourceEventType } : {}),
      ...(row.sourceEventId ? { sourceEventId: row.sourceEventId } : {}),
    });
  } catch (err) {
    process.stderr.write(
      `[notification-center/repo] bus.emit failed for ${row.id}: ${(err as Error).message}\n`,
    );
  }
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
