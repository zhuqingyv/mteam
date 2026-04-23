-- ============================================================
-- 8. project_rules —— 项目规则（禁止项 + 必须遵守项）
-- ============================================================
CREATE TABLE IF NOT EXISTS project_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK(kind IN ('forbidden','rules')),
  seq              INTEGER NOT NULL,
  content          TEXT NOT NULL,
  created_by_instance_id TEXT REFERENCES role_instances(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pr_project_kind_seq
  ON project_rules(project_id, kind, seq);
CREATE INDEX IF NOT EXISTS idx_pr_project    ON project_rules(project_id);
