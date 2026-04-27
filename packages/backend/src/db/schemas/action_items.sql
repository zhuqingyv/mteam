-- ============================================================
-- action_items —— 统一待办/审批/决策/授权
-- 不改 messages 表；与 messages 通过 related_message_uuid 软关联。
-- ============================================================
CREATE TABLE IF NOT EXISTS action_items (
  id                    TEXT PRIMARY KEY,                -- UUID v4
  kind                  TEXT NOT NULL CHECK(kind IN ('task','approval','decision','authorization')),
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',

  creator_kind          TEXT NOT NULL CHECK(creator_kind IN ('user','agent','system')),
  creator_id            TEXT NOT NULL,
  assignee_kind         TEXT NOT NULL CHECK(assignee_kind IN ('user','agent','system')),
  assignee_id           TEXT NOT NULL,

  deadline              INTEGER NOT NULL,                -- ms epoch
  status                TEXT NOT NULL CHECK(status IN ('pending','in_progress','done','rejected','timeout','cancelled'))
                                    DEFAULT 'pending',

  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  reminded_at           INTEGER,                         -- null 表示未提醒过

  resolution            TEXT,

  team_id               TEXT,
  related_message_uuid  TEXT                             -- 软关联 messages.envelope_uuid
);

-- 列表/统计：按 assignee 拉未完成项
CREATE INDEX IF NOT EXISTS idx_action_items_assignee_status
  ON action_items(assignee_kind, assignee_id, status);

-- 创建者视角：查"我发出的待办"
CREATE INDEX IF NOT EXISTS idx_action_items_creator_status
  ON action_items(creator_kind, creator_id, status);

-- 调度扫描：找下一个 deadline 未超时的
CREATE INDEX IF NOT EXISTS idx_action_items_status_deadline
  ON action_items(status, deadline);
