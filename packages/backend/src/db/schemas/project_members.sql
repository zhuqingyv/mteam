-- ============================================================
-- 7. project_members —— 实例加入 project 的历史记录
-- ============================================================
-- 实例从 STARTING → WORKING 时，若绑定了 project_id 则自动加入
CREATE TABLE IF NOT EXISTS project_members (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_id      TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  joined_at        TEXT NOT NULL,
  left_at          TEXT,
  leave_reason     TEXT
);

CREATE INDEX IF NOT EXISTS idx_pm_project    ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_pm_instance   ON project_members(instance_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_active
  ON project_members(project_id, instance_id)
  WHERE left_at IS NULL;
