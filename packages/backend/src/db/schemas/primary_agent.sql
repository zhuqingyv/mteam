-- ============================================================
-- primary_agent —— 全局主 Agent（单行）
-- 应用门面 Agent，生命周期跟随应用。独立于 role_instances 体系。
-- id 永久唯一：首次 configure 时生成，之后切换 CLI / 重启 / 重配都不变。
-- ============================================================
CREATE TABLE IF NOT EXISTS primary_agent (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  cli_type      TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  mcp_config    TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'STOPPED'
                CHECK(status IN ('STOPPED','RUNNING')),
  -- 主 Agent 默认走沙箱 + 权限全自动（秘书身份，不需要人看着）
  sandbox       INTEGER NOT NULL DEFAULT 1 CHECK(sandbox IN (0,1)),
  auto_approve  INTEGER NOT NULL DEFAULT 1 CHECK(auto_approve IN (0,1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
