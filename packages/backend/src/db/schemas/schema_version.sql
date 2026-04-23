-- ============================================================
-- 11. schema_version —— 版本记录
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_version (
  version          INTEGER PRIMARY KEY,
  applied_at       TEXT NOT NULL,
  note             TEXT
);
