// Sessions / 消息收发 领域 —— [待 D6 + D1]
//
// 服务端现有端点 /api/messages/send、/api/role-instances/:id/inbox、/api/teams/:id/messages
// 全部在顶级 /api/*，前端硬门禁禁止直连。D6 facade 未落地前只能 stub。
// 此外 D1（消息三路分发设计）也未定下前端的"通讯路订阅"规则，因此聊天收发
// 链路同时被 D1 + D6 双重阻塞（PRD §1.2）。
//
// 未来服务端 facade 映射参考：
//   listSessions → GET  /api/panel/sessions                  （会话列表，等价于 driverId 列表）
//   getSession   → GET  /api/panel/sessions/:id              （等价 /driver/:id/turns 快照）
//   sendMessage  → POST /api/panel/sessions/:id/messages     （转发 /api/messages/send）

import { panelPending, type ApiResult } from './client';

export interface SessionSummary {
  sessionId: string;
  driverId: string;
  instanceId: string;
  memberName: string;
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface SessionDetail extends SessionSummary {
  // 真实形状等 D2 Turn 接口与 D1 通讯路契约对齐后再补。
  meta?: Record<string, unknown>;
}

export interface SendMessageBody {
  content: string;
  kind?: 'chat' | 'task' | 'broadcast';
  summary?: string;
  replyTo?: string;
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

export function sendMessage(
  _sessionId: string,
  _body: SendMessageBody,
): Promise<ApiResult<SendMessageResult>> {
  return panelPending<SendMessageResult>('sessions.sendMessage');
}
