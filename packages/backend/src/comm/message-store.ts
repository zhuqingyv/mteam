// messages 表 DAO（W1-C）。只依赖 envelope 类型 + getDb()，不碰 bus/router/mcp。
// envelope 同步落库是 router 契约：落库后 msg_id 才稳定，agent 立即 read_message 才不 404（I-08）。
//
// prepare 提升：factory 内部把固定 SQL 一次性 prepare 到闭包变量，避免每次 insert/find
// 重复编译。动态 SQL（findMessagesAfter 里按 address 前缀分支 + 是否带游标）仍逐次 prepare。

import type { ActorKind, ActorRef, MessageEnvelope, MessageKind } from './envelope.js';
import { getDb } from '../db/connection.js';

export interface InboxSummary {
  id: string;
  from: { kind: string; address: string; displayName: string; instanceId: string | null; memberName: string | null };
  summary: string;
  kind: MessageKind;
  replyTo: string | null;
  ts: string;
  readAt: string | null;
}

export interface MessageStore {
  insert(env: MessageEnvelope): number;
  findById(id: string): MessageEnvelope | null;
  markRead(id: string, at?: Date): number;
  listInbox(toInstanceId: string, opts: { peek: boolean; limit?: number }): { messages: InboxSummary[]; total: number };
  listTeamHistory(teamId: string, opts: { before?: string; limit?: number }): { items: InboxSummary[]; nextBefore: string | null; hasMore: boolean };
  findUnreadFor(toInstanceId: string): MessageEnvelope[];
  /**
   * 按 "to 地址" 找未读（W1-D）。比 findUnreadFor(toInstanceId) 通用，gap-replayer 用它。
   * address 形如：
   *   - 'user:<userId>'   → to_user_id = <userId>
   *   - 'local:system'    → to_kind='system' AND to_instance_id IS NULL
   *   - 'local:<instId>'  → to_instance_id = <instId>
   * 不认识的前缀返回空数组（不抛）。
   */
  findUnreadForAddress(address: string): MessageEnvelope[];
  /**
   * 按 "to 地址" + 游标拉 afterMsgId 之后的消息（含已读，W2-B gap-replayer 用）。
   * 联合游标 (sent_at, id) 防同毫秒多条漏/重；afterMsgId 不存在时退化为无游标"最早 limit 条"。
   * 不认识的 address 前缀返回空数组（不抛）。
   */
  findMessagesAfter(address: string, afterMsgId: string, limit: number): MessageEnvelope[];
}

interface Row {
  id: number; envelope_uuid: string;
  from_instance_id: string | null; from_kind: string; from_user_id: string | null; from_display: string;
  to_instance_id: string | null; to_kind: string; to_user_id: string | null; to_display: string;
  team_id: string | null; kind: string; summary: string; content: string;
  sent_at: string; read_at: string | null; reply_to_id: number | null; attachments_json: string | null;
}

function addr(kind: string, instId: string | null, userId: string | null): string {
  if (kind === 'system') return 'local:system';
  if (kind === 'user') return `user:${userId ?? 'local'}`;
  return instId ? `local:${instId}` : 'local:unknown';
}

const fromOf = (r: Row): ActorRef => ({
  kind: r.from_kind as ActorKind,
  address: addr(r.from_kind, r.from_instance_id, r.from_user_id),
  displayName: r.from_display,
  instanceId: r.from_instance_id,
  memberName: null,
});

function summaryFrom(r: Row): InboxSummary['from'] {
  return {
    kind: r.from_kind,
    address: addr(r.from_kind, r.from_instance_id, r.from_user_id),
    displayName: r.from_display,
    instanceId: r.from_instance_id,
    memberName: null,
  };
}

const summaryOf = (r: Row, replyTo: string | null): InboxSummary => ({
  id: r.envelope_uuid, from: summaryFrom(r), summary: r.summary,
  kind: r.kind as MessageKind, replyTo, ts: r.sent_at, readAt: r.read_at,
});

function envelopeOf(r: Row, replyTo: string | null): MessageEnvelope {
  let attachments: MessageEnvelope['attachments'];
  if (r.attachments_json) {
    try {
      const p = JSON.parse(r.attachments_json) as unknown;
      if (Array.isArray(p)) attachments = p as MessageEnvelope['attachments'];
    } catch { /* 坏 JSON 就省掉 attachments */ }
  }
  return {
    id: r.envelope_uuid, from: fromOf(r),
    to: {
      kind: r.to_kind as ActorKind,
      address: addr(r.to_kind, r.to_instance_id, r.to_user_id),
      displayName: r.to_display, instanceId: r.to_instance_id, memberName: null,
    },
    teamId: r.team_id, kind: r.kind as MessageKind, summary: r.summary,
    content: r.content, replyTo, ts: r.sent_at, readAt: r.read_at, attachments,
  };
}

const stripUser = (a: string) => (a.startsWith('user:') ? a.slice(5) : a);

export function createMessageStore(): MessageStore {
  const db = getDb();
  // factory 闭包：每次 createMessageStore() 把固定 SQL 全部 prepare 一次，后续调用复用。
  // 测试 beforeEach 里 closeDb + 重建 store，会拿到新 handle + 新 prepare，不会用到死 handle。
  const sSelectUuidById = db.prepare('SELECT envelope_uuid FROM messages WHERE id = ?');
  const sSelectIdByUuid = db.prepare('SELECT id FROM messages WHERE envelope_uuid = ?');
  const sByUuid = db.prepare('SELECT * FROM messages WHERE envelope_uuid = ?');
  const sInsert = db.prepare(
    `INSERT INTO messages (envelope_uuid, from_instance_id, from_kind, from_user_id, from_display,
       to_instance_id, to_kind, to_user_id, to_display, team_id, kind, summary, content,
       sent_at, read_at, reply_to_id, attachments_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const sMarkRead = db.prepare(
    'UPDATE messages SET read_at = ? WHERE envelope_uuid = ? AND read_at IS NULL',
  );
  const sInboxList = db.prepare(
    `SELECT * FROM messages WHERE to_instance_id = ? AND read_at IS NULL
       ORDER BY sent_at ASC, id ASC LIMIT ?`,
  );
  const sInboxCount = db.prepare(
    'SELECT COUNT(*) AS c FROM messages WHERE to_instance_id = ? AND read_at IS NULL',
  );
  const sTeamBefore = db.prepare(
    `SELECT * FROM messages WHERE team_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
  );
  const sTeamAll = db.prepare(
    `SELECT * FROM messages WHERE team_id = ? ORDER BY id DESC LIMIT ?`,
  );
  const sUnreadByInst = db.prepare(
    `SELECT * FROM messages WHERE to_instance_id = ? AND read_at IS NULL
       ORDER BY sent_at ASC, id ASC`,
  );
  const sUnreadByUser = db.prepare(
    `SELECT * FROM messages WHERE to_user_id = ? AND read_at IS NULL
       ORDER BY sent_at ASC, id ASC`,
  );
  const sUnreadSystem = db.prepare(
    `SELECT * FROM messages WHERE to_kind = 'system' AND to_instance_id IS NULL AND read_at IS NULL
       ORDER BY sent_at ASC, id ASC`,
  );
  const sCursorByUuid = db.prepare(
    'SELECT sent_at, id FROM messages WHERE envelope_uuid = ?',
  );

  const uuidOfId = (id: number | null): string | null => {
    if (id == null) return null;
    const r = sSelectUuidById.get(id) as { envelope_uuid: string } | undefined;
    return r?.envelope_uuid ?? null;
  };
  const idOfUuid = (u: string | null): number | null => {
    if (!u) return null;
    const r = sSelectIdByUuid.get(u) as { id: number } | undefined;
    return r?.id ?? null;
  };

  return {
    insert(env) {
      // 幂等：router 的同步落库可能因上游重试重入；同 envelope_uuid 返回既有 dbId
      const hit = sByUuid.get(env.id) as Row | undefined;
      if (hit) return hit.id;
      const r = sInsert.run(
        env.id,
        env.from.instanceId ?? null,
        env.from.kind,
        env.from.kind === 'user' ? stripUser(env.from.address) : null,
        env.from.displayName,
        env.to.instanceId ?? null,
        env.to.kind,
        env.to.kind === 'user' ? stripUser(env.to.address) : null,
        env.to.displayName,
        env.teamId ?? null,
        env.kind,
        env.summary,
        env.content ?? '',
        env.ts,
        env.readAt ?? null,
        idOfUuid(env.replyTo),
        env.attachments ? JSON.stringify(env.attachments) : null,
      );
      return Number(r.lastInsertRowid);
    },

    findById(id) {
      const row = sByUuid.get(id) as Row | undefined;
      return row ? envelopeOf(row, uuidOfId(row.reply_to_id)) : null;
    },

    markRead(id, at) {
      const ts = (at ?? new Date()).toISOString();
      const r = sMarkRead.run(ts, id);
      return Number(r.changes);
    },

    listInbox(toInstanceId, opts) {
      const limit = opts.limit ?? 50;
      const rows = sInboxList.all(toInstanceId, limit) as Row[];
      const total = (sInboxCount.get(toInstanceId) as { c: number } | undefined)?.c ?? 0;
      // 先快照再批量标记已读；返回的 summary.readAt 反映"取走时的未读态"
      if (!opts.peek && rows.length > 0) {
        const now = new Date().toISOString();
        db.transaction((list: Row[]) => {
          for (const x of list) sMarkRead.run(now, x.envelope_uuid);
        })(rows);
      }
      return { messages: rows.map((r) => summaryOf(r, uuidOfId(r.reply_to_id))), total };
    },

    listTeamHistory(teamId, opts) {
      const limit = opts.limit ?? 50;
      // before 是 envelope_uuid 游标：对前端稳定，内部翻成 db id 比较
      const beforeDbId = idOfUuid(opts.before ?? null);
      const rows =
        beforeDbId != null
          ? (sTeamBefore.all(teamId, beforeDbId, limit + 1) as Row[])
          : (sTeamAll.all(teamId, limit + 1) as Row[]);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        items: page.map((r) => summaryOf(r, uuidOfId(r.reply_to_id))),
        nextBefore: hasMore ? page[page.length - 1]!.envelope_uuid : null,
        hasMore,
      };
    },

    findUnreadFor(toInstanceId) {
      const rows = sUnreadByInst.all(toInstanceId) as Row[];
      return rows.map((r) => envelopeOf(r, uuidOfId(r.reply_to_id)));
    },

    findUnreadForAddress(address) {
      let rows: Row[] = [];
      if (address.startsWith('user:')) {
        rows = sUnreadByUser.all(address.slice(5)) as Row[];
      } else if (address === 'local:system') {
        rows = sUnreadSystem.all() as Row[];
      } else if (address.startsWith('local:')) {
        rows = sUnreadByInst.all(address.slice(6)) as Row[];
      }
      return rows.map((r) => envelopeOf(r, uuidOfId(r.reply_to_id)));
    },

    findMessagesAfter(address, afterMsgId, limit) {
      // 解析游标：afterMsgId → (sent_at, id)；不存在则退化为无游标（"最早 limit 条"）
      const cur = sCursorByUuid.get(afterMsgId) as { sent_at: string; id: number } | null | undefined;
      const whereCur = cur ? 'AND (sent_at > ? OR (sent_at = ? AND id > ?))' : '';
      const order = 'ORDER BY sent_at ASC, id ASC LIMIT ?';
      // 地址分支 × 有无游标 = 6 种组合；全部动态 SQL，逐次 prepare（非热路径也可接受）。
      let rows: Row[] = [];
      if (address.startsWith('user:')) {
        const uid = address.slice(5);
        const sql = `SELECT * FROM messages WHERE to_user_id = ? ${whereCur} ${order}`;
        rows = (cur
          ? db.prepare(sql).all(uid, cur.sent_at, cur.sent_at, cur.id, limit)
          : db.prepare(sql).all(uid, limit)) as Row[];
      } else if (address === 'local:system') {
        const sql = `SELECT * FROM messages WHERE to_kind = 'system' AND to_instance_id IS NULL ${whereCur} ${order}`;
        rows = (cur
          ? db.prepare(sql).all(cur.sent_at, cur.sent_at, cur.id, limit)
          : db.prepare(sql).all(limit)) as Row[];
      } else if (address.startsWith('local:')) {
        const instId = address.slice(6);
        const sql = `SELECT * FROM messages WHERE to_instance_id = ? ${whereCur} ${order}`;
        rows = (cur
          ? db.prepare(sql).all(instId, cur.sent_at, cur.sent_at, cur.id, limit)
          : db.prepare(sql).all(instId, limit)) as Row[];
      }
      return rows.map((r) => envelopeOf(r, uuidOfId(r.reply_to_id)));
    },
  };
}
