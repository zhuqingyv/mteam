// messages 表 v1 -> v2 迁移：补齐 envelope 对齐列 + backfill + UNIQUE 索引升级
// 幂等：靠 PRAGMA table_info / sqlite_master 判定，跑多次不报错、不覆盖既有值
import type { Database } from 'bun:sqlite';

type ColumnInfo = { name: string; notnull: number; dflt_value: unknown; type: string };
type IndexInfo = { name: string; sql: string | null };

const V2_COLUMNS: Array<{ name: string; ddl: string }> = [
  {
    name: 'from_kind',
    ddl: "ALTER TABLE messages ADD COLUMN from_kind TEXT NOT NULL DEFAULT 'agent' CHECK(from_kind IN ('user','agent','system'))",
  },
  { name: 'from_user_id', ddl: 'ALTER TABLE messages ADD COLUMN from_user_id TEXT' },
  {
    name: 'from_display',
    ddl: "ALTER TABLE messages ADD COLUMN from_display TEXT NOT NULL DEFAULT ''",
  },
  {
    name: 'to_kind',
    ddl: "ALTER TABLE messages ADD COLUMN to_kind TEXT NOT NULL DEFAULT 'agent' CHECK(to_kind IN ('user','agent','system'))",
  },
  // to_user_id：agent→user 消息承载用户地址，和 from_user_id 对称
  { name: 'to_user_id', ddl: 'ALTER TABLE messages ADD COLUMN to_user_id TEXT' },
  {
    name: 'to_display',
    ddl: "ALTER TABLE messages ADD COLUMN to_display TEXT NOT NULL DEFAULT ''",
  },
  {
    name: 'envelope_uuid',
    ddl: "ALTER TABLE messages ADD COLUMN envelope_uuid TEXT NOT NULL DEFAULT ''",
  },
  { name: 'attachments_json', ddl: 'ALTER TABLE messages ADD COLUMN attachments_json TEXT' },
];

// 老库 to_instance_id NOT NULL 需要去掉：SQLite 不支持 ALTER COLUMN DROP NOT NULL，
// 只能走"建新表→拷数据→换名"。仅当当前 to_instance_id 仍为 NOT NULL 时才执行。
function relaxToInstanceIdNotNull(db: Database): void {
  const cols = db.prepare('PRAGMA table_info(messages)').all() as ColumnInfo[];
  const to = cols.find((c) => c.name === 'to_instance_id');
  if (!to || to.notnull === 0) return; // 新库或已放宽：直接返回

  // 拷贝现有表的 CREATE 语句用来探查现状，但重建 DDL 我们用 schemas/messages.sql 的目标形状的精简版。
  // 在 FK OFF 的前提下完成重命名切换，避免重建期间出现悬垂引用。
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE messages_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        from_instance_id TEXT REFERENCES role_instances(id) ON DELETE SET NULL,
        to_instance_id   TEXT REFERENCES role_instances(id) ON DELETE CASCADE,
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

  // 重建后 messages 上的索引（由 schemas/messages.sql 定义）全丢了，这里重建关键三条 + 未读/reply/team。
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_to_unread ON messages(to_instance_id, sent_at DESC) WHERE read_at IS NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_to   ON messages(to_instance_id, sent_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_from ON messages(from_instance_id, sent_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_team ON messages(team_id, sent_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_reply ON messages(reply_to_id)');
}

export function migrateMessagesEnvelope(db: Database): void {
  const cols = db.prepare('PRAGMA table_info(messages)').all() as ColumnInfo[];
  if (cols.length === 0) return; // 表还没建成：applySchemas 失败才会走到这，交给上层报错
  const has = (n: string) => cols.some((c) => c.name === n);

  const addedAny = V2_COLUMNS.reduce((acc, c) => {
    if (has(c.name)) return acc;
    db.exec(c.ddl);
    return true;
  }, false);

  if (addedAny) {
    db.exec(
      "UPDATE messages SET envelope_uuid = 'msg_' || id WHERE envelope_uuid IS NULL OR envelope_uuid = ''"
    );
    db.exec(
      "UPDATE messages SET from_kind = 'system' WHERE from_instance_id IS NULL AND from_kind = 'agent'"
    );
  }

  relaxToInstanceIdNotNull(db);

  // v2 列补齐后再建依赖它们的索引（老库先加列，新库 applySchemas 已建表但这些索引不在 .sql 里）
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_msg_from_kind ON messages(from_kind, sent_at DESC)'
  );

  // envelope_uuid UNIQUE 索引：backfill 完成后建立。若已存在非 UNIQUE 版本则替换。
  const idx = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_msg_env_uuid'"
    )
    .get() as IndexInfo | undefined;
  const isUnique = !!idx && typeof idx.sql === 'string' && /\bUNIQUE\b/i.test(idx.sql);
  if (!isUnique) {
    if (idx) db.exec('DROP INDEX idx_msg_env_uuid');
    db.exec('CREATE UNIQUE INDEX idx_msg_env_uuid ON messages(envelope_uuid)');
  }
}
