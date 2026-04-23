-- ============================================================
-- 4. teams —— 团队
-- ============================================================
-- leader 调 request_member 时自动创建；一个 leader 实例对应一个 team
CREATE TABLE IF NOT EXISTS teams (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  leader_instance_id TEXT NOT NULL REFERENCES role_instances(id),
  project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
  description      TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK(status IN ('active','disbanded')),
  created_at       TEXT NOT NULL,
  disbanded_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_teams_leader   ON teams(leader_instance_id);
CREATE INDEX IF NOT EXISTS idx_teams_project  ON teams(project_id);
CREATE INDEX IF NOT EXISTS idx_teams_status   ON teams(status);
