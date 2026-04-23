-- ============================================================
-- 5. team_members —— 实例加入 team 的历史记录
-- ============================================================
-- 一个实例加入/离开 team 产生一条记录；left_at IS NULL 表示当前仍在
CREATE TABLE IF NOT EXISTS team_members (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  instance_id      TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  role_in_team     TEXT,
  joined_at        TEXT NOT NULL,
  left_at          TEXT,
  leave_reason     TEXT
);

CREATE INDEX IF NOT EXISTS idx_tm_team       ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_tm_instance   ON team_members(instance_id);
-- 当前仍在 team 的成员
CREATE INDEX IF NOT EXISTS idx_tm_active
  ON team_members(team_id, instance_id)
  WHERE left_at IS NULL;
-- 同一实例在同一 team 的活跃记录唯一
CREATE UNIQUE INDEX IF NOT EXISTS uq_tm_active
  ON team_members(team_id, instance_id)
  WHERE left_at IS NULL;
