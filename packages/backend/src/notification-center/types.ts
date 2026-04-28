// Phase 5 · OA 通知中心类型。设计：docs/phase5/notification-system-design.md
// 与 src/notification/ 的区别：后者是 proxy-router 配置；本模块是通知实体 + 持久化。

export type NotificationKind =
  | 'quota_limit'
  | 'action_item_reminder'
  | 'action_item_timeout'
  | 'agent_error'
  | 'team_lifecycle'
  | 'instance_lifecycle'
  | 'approval'
  | 'system';

export type NotificationChannel = 'system' | 'in_app' | 'both';

export type Severity = 'info' | 'warn' | 'error';

export interface NotificationRecord {
  id: string;
  userId: string | null;
  kind: NotificationKind;
  channel: NotificationChannel;
  severity: Severity;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  sourceEventType?: string;
  sourceEventId?: string;
  acknowledgedAt: string | null;
  createdAt: string;
}
