import { getDb } from '../db/connection.js';
import { parseAddress } from './protocol.js';
import type { Message } from './types.js';

interface Row {
  id: number;
  from_instance_id: string | null;
  to_instance_id: string;
  summary: string;
  content: string;
  sent_at: string;
}

function extractInstanceId(addr: string): string | null {
  try {
    const { scope, id } = parseAddress(addr);
    if (scope !== 'local' || id === 'system') return null;
    return id;
  } catch {
    return null;
  }
}

export function store(msg: Message): number | null {
  const toId = extractInstanceId(msg.to);
  if (!toId) return null;
  const fromId = extractInstanceId(msg.from);
  const summary =
    typeof msg.payload.summary === 'string' ? msg.payload.summary : '';
  const content = JSON.stringify(msg.payload);
  const db = getDb();
  try {
    const r = db
      .prepare(
        `INSERT INTO messages
           (from_instance_id, to_instance_id, kind, summary, content, sent_at)
         VALUES (?, ?, 'chat', ?, ?, ?)`,
      )
      .run(fromId, toId, summary, content, msg.ts);
    return Number(r.lastInsertRowid);
  } catch {
    return null;
  }
}

export function replayFor(address: string): Message[] {
  const toId = extractInstanceId(address);
  if (!toId) return [];
  const rows = getDb()
    .prepare(
      `SELECT id, from_instance_id, to_instance_id, summary, content, sent_at
         FROM messages
        WHERE to_instance_id = ? AND read_at IS NULL
        ORDER BY sent_at ASC`,
    )
    .all(toId) as Row[];
  const out: Message[] = [];
  for (const r of rows) {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(r.content) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      } else {
        payload = { content: r.content };
      }
    } catch {
      payload = { content: r.content };
    }
    out.push({
      type: 'message',
      id: String(r.id),
      from: r.from_instance_id
        ? (`local:${r.from_instance_id}` as Message['from'])
        : ('local:system' as Message['from']),
      to: `local:${r.to_instance_id}` as Message['to'],
      payload,
      ts: r.sent_at,
    });
  }
  return out;
}

export function markDelivered(msgId: string | number): void {
  const numericId = Number(msgId);
  if (!Number.isFinite(numericId)) return;
  getDb()
    .prepare(`UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL`)
    .run(new Date().toISOString(), numericId);
}
