-- ============================================================
-- notifications —— Phase 5 OA 通知中心
-- 设计：docs/phase5/notification-system-design.md
-- 独立于 notification_configs（后者是 proxy-router 配置）
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT,                                   -- NULL = 系统默认用户
  kind               TEXT NOT NULL,
  channel            TEXT NOT NULL DEFAULT 'system',
  severity           TEXT NOT NULL DEFAULT 'info',
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  payload            TEXT NOT NULL DEFAULT '{}',             -- JSON 字符串
  source_event_type  TEXT,
  source_event_id    TEXT,
  acknowledged_at    TEXT,                                   -- NULL = 未读
  created_at         TEXT NOT NULL
);

-- 未读过滤走部分索引，单用户场景 O(log n)
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, acknowledged_at) WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_created
  ON notifications(created_at DESC);
