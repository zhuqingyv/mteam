-- ============================================================
-- 12. notification_configs —— 通知代理模式配置（Phase WS · W1-H）
-- ============================================================
-- 每个 user_id 一条；user_id IS NULL 代表系统缺省（单用户场景即 'default'）
-- mode:
--   proxy_all = 所有 notifiable 事件发给 primary agent
--   direct    = 所有 notifiable 事件直推 user（WS 下行）
--   custom    = 按 rules_json（CustomRule[]）自顶向下匹配
-- rules_json 仅在 mode='custom' 时读取；其它模式允许为 NULL
-- 查询路径：notification.subscriber 每次事件 → store.get(userId)
CREATE TABLE IF NOT EXISTS notification_configs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  mode       TEXT NOT NULL CHECK(mode IN ('proxy_all','direct','custom')),
  rules_json TEXT,
  updated_at TEXT NOT NULL
);

-- user_id UNIQUE：每个 user 最多一条配置；NULL 也参与 UNIQUE
-- SQLite 里 UNIQUE 把多个 NULL 视作不同，所以需要保持 default 行 id='default' 自己约束唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_user ON notification_configs(user_id);
