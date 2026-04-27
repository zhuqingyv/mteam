-- ============================================================
-- avatars —— 头像库（独立于角色模板的资源池）
-- ============================================================
CREATE TABLE IF NOT EXISTS avatars (
  id          TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  builtin     INTEGER NOT NULL DEFAULT 0,  -- 1=系统内置 0=用户上传
  hidden      INTEGER NOT NULL DEFAULT 0,  -- 1=被用户隐藏（仅内置可隐藏）
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_avatars_visible ON avatars(hidden);
