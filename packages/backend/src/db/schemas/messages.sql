-- ============================================================
-- 9. messages —— 实例间通信（v2：envelope 对齐）
-- ============================================================
-- v1 保留：from_instance_id NULL 表示系统消息（由 from_kind='system' 覆盖）
-- v2 扩列对齐 MessageEnvelope：from_kind/from_user_id/from_display、
--   to_kind/to_user_id/to_display、envelope_uuid（对外 id）、attachments_json
-- Why 这些列：envelope.from / envelope.to 需要原样回放（见 comm-model-design.md §4.2）
--   把"发送时冻结"的 display 名直接放进表，避免后续 role_instances 重命名/删除导致历史信封失真
-- Why to_instance_id nullable：agent→user 消息里 user 没有 instanceId，改 nullable 让 insert 不再因 NOT NULL 报错；
--   对应新增 to_user_id 承载 user 地址（与 from_user_id 对称）
-- Why 不对 role_instances 建 FK：主 Agent id 来自 primary_agent 表而非 role_instances，
--   原 FK 会让 user→primary agent 的 prompt 落库触发 FOREIGN KEY constraint failed。
--   业务层已有 lookup 校验；role_instance 删除时的消息清理交给业务层 cleanup。
CREATE TABLE IF NOT EXISTS messages (
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

  -- v2 新增
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
);

CREATE INDEX IF NOT EXISTS idx_msg_to_unread
  ON messages(to_instance_id, sent_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_msg_to        ON messages(to_instance_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_from      ON messages(from_instance_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_team      ON messages(team_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_reply     ON messages(reply_to_id);
-- 依赖 v2 列（from_kind / envelope_uuid）的索引由 migrateMessagesEnvelope 建立，
-- 避免老库在 applySchemas 阶段因列缺失而崩溃。
