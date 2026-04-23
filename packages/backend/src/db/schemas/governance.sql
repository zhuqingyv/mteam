-- ============================================================
-- 10. governance —— 团队治理规则（KV 存储）
-- ============================================================
CREATE TABLE IF NOT EXISTS governance (
  key              TEXT PRIMARY KEY,
  value_json       TEXT NOT NULL,
  updated_by_instance_id TEXT REFERENCES role_instances(id) ON DELETE SET NULL,
  updated_at       TEXT NOT NULL
);
