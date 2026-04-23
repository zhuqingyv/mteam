-- ============================================================
-- 6. projects —— 项目
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'planning'
                   CHECK(status IN ('planning','designing','developing',
                                    'testing','bugfixing','done','abandoned')),
  progress         INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  experience       TEXT NOT NULL DEFAULT '',
  created_by_instance_id TEXT REFERENCES role_instances(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_status_updated ON projects(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_created_by     ON projects(created_by_instance_id);
