// Sessions / 消息 —— /api/panel/messages 转发 /api/messages/send（必须带 to.address）。
// /api/panel/messages/:id 按 envelope id 拉单条。会话列表 / inbox / team 历史 暂无 facade。

import { panelGet, panelPost, panelPending, type ApiResult } from './client';

export interface SessionSummary {
  sessionId: string;
  driverId: string;
  instanceId: string;
  memberName: string;
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface SessionDetail extends SessionSummary {
  meta?: Record<string, unknown>;
}

export interface SendMessageBody {
  to: { address: string; kind?: 'agent'; instanceId?: string };
  content: string;
  kind?: 'chat' | 'task' | 'broadcast';
  summary?: string;
  replyTo?: string;
  attachments?: Array<{ type: string; [key: string]: unknown }>;
}

export interface SendMessageResult {
  messageId: string;
  route: string;
}

export function listSessions(): Promise<ApiResult<SessionSummary[]>> {
  return panelPending<SessionSummary[]>('sessions.list');
}

export function getSession(_sessionId: string): Promise<ApiResult<SessionDetail>> {
  return panelPending<SessionDetail>('sessions.get');
}

export function sendMessage(body: SendMessageBody): Promise<ApiResult<SendMessageResult>> {
  return panelPost<SendMessageResult>('/messages', body);
}

export function getMessage(id: string): Promise<ApiResult<{ envelope: unknown }>> {
  return panelGet<{ envelope: unknown }>(`/messages/${encodeURIComponent(id)}`);
}
