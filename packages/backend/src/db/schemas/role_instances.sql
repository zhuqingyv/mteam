-- ============================================================
-- role_instances —— 角色实例
-- 状态只有 PENDING / ACTIVE；下线 = 物理删除
-- ============================================================
CREATE TABLE IF NOT EXISTS role_instances (
  id                TEXT PRIMARY KEY,
  template_name     TEXT NOT NULL REFERENCES role_templates(name),
  member_name       TEXT NOT NULL,
  alias             TEXT,
  is_leader         INTEGER NOT NULL DEFAULT 0 CHECK(is_leader IN (0,1)),
  team_id           TEXT,
  project_id        TEXT,
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK(status IN ('PENDING','ACTIVE','PENDING_OFFLINE')),
  session_id        TEXT UNIQUE,
  session_pid       INTEGER,
  claude_session_id TEXT,
  leader_name       TEXT,
  task              TEXT,
  -- 成员默认不走沙箱、不自动批准（保守侧，避免未经审查的 host 改动）
  sandbox           INTEGER NOT NULL DEFAULT 0 CHECK(sandbox IN (0,1)),
  auto_approve      INTEGER NOT NULL DEFAULT 0 CHECK(auto_approve IN (0,1)),
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ri_member   ON role_instances(member_name);
CREATE INDEX IF NOT EXISTS idx_ri_template ON role_instances(template_name);
CREATE INDEX IF NOT EXISTS idx_ri_status   ON role_instances(status);
CREATE INDEX IF NOT EXISTS idx_ri_session  ON role_instances(session_id);
