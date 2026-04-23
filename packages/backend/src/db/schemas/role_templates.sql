-- ============================================================
-- 1. role_templates —— 角色模板
-- ============================================================
CREATE TABLE IF NOT EXISTS role_templates (
  name             TEXT PRIMARY KEY,
  role             TEXT NOT NULL,
  description      TEXT,
  persona          TEXT,
  available_mcps   TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rt_role ON role_templates(role);
