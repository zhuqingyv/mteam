-- ============================================================
-- visibility_rules —— 可见性规则（Phase WS W1-F）
-- 独立表，不外键 role_instances / users / messages：
--   principal_ref 可能是已删除实例的 id，规则应继续存在并随时间自然清理；
--   加外键会让"删除实例" cascade 掉历史规则，失去可追溯性。
-- principal_ref 允许 NULL：kind='system' 时没有"具体主体",NULL 语义即"所有 system 事件"。
-- target_ref 允许 NULL：同理，未来 kind 可能扩展无 ref 的聚合目标。
-- ============================================================
CREATE TABLE IF NOT EXISTS visibility_rules (
  id              TEXT PRIMARY KEY,
  principal_kind  TEXT NOT NULL CHECK(principal_kind IN ('user','agent','system')),
  principal_ref   TEXT,
  target_kind     TEXT NOT NULL CHECK(target_kind IN ('user','agent','system','team')),
  target_ref      TEXT,
  effect          TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  note            TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_filter_principal ON visibility_rules(principal_kind, principal_ref);
CREATE INDEX IF NOT EXISTS idx_filter_target    ON visibility_rules(target_kind, target_ref);
