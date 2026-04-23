-- ============================================================
-- 4. teams —— 团队
-- ============================================================
-- team 只管"谁和谁是一个组"的关系，不绑 project。
-- leader 调 request_member 时由业务层自动创建；一个 leader 实例对应一个 active team。
-- leader_instance_id 上 ON DELETE CASCADE —— leader 被删 team 直接消失。
CREATE TABLE IF NOT EXISTS teams (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  leader_instance_id TEXT NOT NULL REFERENCES role_instances(id) ON DELETE CASCADE,
  description        TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'ACTIVE'
                     CHECK(status IN ('ACTIVE','DISBANDED')),
  created_at         TEXT NOT NULL,
  disbanded_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_teams_leader ON teams(leader_instance_id);
CREATE INDEX IF NOT EXISTS idx_teams_status ON teams(status);

-- 一个 leader 同时只能有一个 ACTIVE team；partial unique index 不影响 DISBANDED 历史行。
CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_active_leader
  ON teams(leader_instance_id) WHERE status = 'ACTIVE';
