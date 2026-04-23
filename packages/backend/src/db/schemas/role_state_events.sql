-- ============================================================
-- role_state_events —— 状态变更审计日志
-- 无外键：实例物理删除后，审计日志仍保留
-- ============================================================
CREATE TABLE IF NOT EXISTS role_state_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id    TEXT NOT NULL,
  from_state     TEXT,
  to_state       TEXT NOT NULL,
  event          TEXT NOT NULL,
  actor          TEXT,
  at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rse_instance ON role_state_events(instance_id);
