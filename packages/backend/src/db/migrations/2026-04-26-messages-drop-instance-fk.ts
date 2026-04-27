// messages 表：去除 from_instance_id / to_instance_id 对 role_instances 的 FK。
//
// Why：主 Agent id 存在 primary_agent 表，不在 role_instances。原 FK 导致
// user → primary agent 的 prompt 落库时 FOREIGN KEY constraint failed → store-failure → dropped。
// 业务层已有 lookup 校验，DB 层 FK 只是保险；放开后 primary_agent 和普通
// role_instance 统一走 messages.to_instance_id（TEXT 无约束）。
//
// 代价：失去对 role_instances 删除时的 ON DELETE CASCADE / SET NULL。
// 若将来需要删 role_instance 时连带清理历史消息，改走业务层 cleanup job。
//
// 幂等：通过 sqlite_master 里 messages 表 CREATE 语句是否还含 "REFERENCES role_instances" 判定。
import type { Database } from 'bun:sqlite';

type MasterRow = { sql: string | null };

function stillReferencesRoleInstances(db: Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'")
    .get() as MasterRow | undefined;
  if (!row || typeof row.sql !== 'string') return false;
  return /REFERENCES\s+role_instances/i.test(row.sql);
}

export function migrateMessagesDropInstanceFk(db: Database): void {
  if (!stillReferencesRoleInstances(db)) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE messages_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        from_instance_id TEXT,
        to_instance_id   TEXT,
        team_id          TEXT REFERENCES teams(id) ON DELETE SET NULL,
        kind             TEXT NOT NULL DEFAULT 'chat'
                         CHECK(kind IN ('chat','task','broadcast','system')),
        summary          TEXT NOT NULL DEFAULT '',
        content          TEXT NOT NULL,
        sent_at          TEXT NOT NULL,
        read_at          TEXT,
        reply_to_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        from_kind        TEXT NOT NULL DEFAULT 'agent'
                         CHECK(from_kind IN ('user','agent','system')),
        from_user_id     TEXT,
        from_display     TEXT NOT NULL DEFAULT '',
        to_kind          TEXT NOT NULL DEFAULT 'agent'
                         CHECK(to_kind IN ('user','agent','system')),
        to_user_id       TEXT,
        to_display       TEXT NOT NULL DEFAULT '',
        envelope_uuid    TEXT NOT NULL DEFAULT '',
        attachments_json TEXT
      )
    `);
    db.exec(`
      INSERT INTO messages_new
        (id, from_instance_id, to_instance_id, team_id, kind, summary, content,
         sent_at, read_at, reply_to_id,
         from_kind, from_user_id, from_display,
         to_kind, to_user_id, to_display, envelope_uuid, attachments_json)
      SELECT id, from_instance_id, to_instance_id, team_id, kind, summary, content,
             sent_at, read_at, reply_to_id,
             from_kind, from_user_id, from_display,
             to_kind, to_user_id, to_display, envelope_uuid, attachments_json
      FROM messages
    `);
    db.exec('DROP TABLE messages');
    db.exec('ALTER TABLE messages_new RENAME TO messages');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    throw err;
  }
  db.exec('PRAGMA foreign_keys = ON');

  // 重建索引（重建表会丢）
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_msg_to_unread ON messages(to_instance_id, sent_at DESC) WHERE read_at IS NULL'
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_to   ON messages(to_instance_id, sent_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_from ON messages(from_instance_id, sent_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_team ON messages(team_id, sent_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_reply ON messages(reply_to_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_from_kind ON messages(from_kind, sent_at DESC)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_env_uuid ON messages(envelope_uuid)');
}
