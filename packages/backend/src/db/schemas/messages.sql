-- ============================================================
-- 9. messages —— 实例间通信
-- ============================================================
-- 支持点对点消息；from_instance_id 为 NULL 时表示系统消息
CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  from_instance_id TEXT REFERENCES role_instances(id) ON DELETE SET NULL,
  to_instance_id   TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  team_id          TEXT REFERENCES teams(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL DEFAULT 'chat'
                   CHECK(kind IN ('chat','task','broadcast','system')),
  summary          TEXT NOT NULL DEFAULT '',
  content          TEXT NOT NULL,
  sent_at          TEXT NOT NULL,
  read_at          TEXT,
  reply_to_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_to_unread
  ON messages(to_instance_id, sent_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_msg_to        ON messages(to_instance_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_from      ON messages(from_instance_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_team      ON messages(team_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_reply     ON messages(reply_to_id);
