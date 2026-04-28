-- ============================================================
-- system_configs —— 系统级单键配置（Phase 5 · Agent 配额）
-- ============================================================
-- key 唯一，value_json 存任意 JSON-serializable 值。
-- 首批键：system.maxAgents（同时存活角色实例上限）。
-- 未来可放其他系统级单值（心跳间隔、retry 次数等），避免塞进业务表。
CREATE TABLE IF NOT EXISTS system_configs (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
