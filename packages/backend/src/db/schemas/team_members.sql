-- ============================================================
-- 5. team_members —— 团队成员关系（当前成员快照）
-- ============================================================
-- 一行 = 一个 instance 当前在 team 里。离开 = DELETE，不保留历史。
-- instance 被删时 CASCADE 自动移除；team disband 时走 subscriber 清空。
CREATE TABLE IF NOT EXISTS team_members (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  instance_id  TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  role_in_team TEXT,
  joined_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tm_team     ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_tm_instance ON team_members(instance_id);
-- 同一 instance 在同一 team 只能有一行
CREATE UNIQUE INDEX IF NOT EXISTS uq_tm_member ON team_members(team_id, instance_id);
