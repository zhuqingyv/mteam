-- ============================================================
-- Phase 5 · workflow_templates —— 工作流模板（项目模板）
-- 承载一键装机的团队编排蓝图：roles + taskChain。
-- 内置模板 (builtin=1) PUT/DELETE 一律 403；用户自定义 (builtin=0) 正常 CRUD。
-- roles / task_chain 以 JSON 文本存储，应用层负责 parse/stringify。
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_templates (
  name        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  roles       TEXT NOT NULL DEFAULT '[]',
  task_chain  TEXT NOT NULL DEFAULT '[]',
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wft_builtin ON workflow_templates(builtin);
