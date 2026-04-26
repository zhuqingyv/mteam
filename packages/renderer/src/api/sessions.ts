// Messages —— /api/panel/messages* facade（发消息 / 单条查 / inbox / team 历史）。
import { panelGet, panelPost, type ApiResult } from './client';

export interface ActorRef {
  kind: string; address: string; displayName: string;
  instanceId?: string | null; memberName?: string | null;
}
export interface SendMessageBody {
  to: { address: string; kind?: 'agent'; instanceId?: string };
  content: string; kind?: 'chat' | 'task' | 'broadcast';
  summary?: string; replyTo?: string;
  attachments?: Array<{ type: string; [key: string]: unknown }>;
}
export interface SendMessageResult { messageId: string; route: string }
export interface MessageEnvelope {
  id: string; from: ActorRef; to: ActorRef;
  teamId: string | null; kind: string; summary: string; content?: string;
  replyTo: string | null; ts: string; readAt: string | null;
  attachments?: Array<{ type: string; [k: string]: unknown }>;
}
export interface InboxSummary {
  id: string; from: ActorRef; summary: string; kind: string;
  replyTo: string | null; ts: string; readAt: string | null;
}

export const sendMessage = (body: SendMessageBody) =>
  panelPost<SendMessageResult>('/messages', body);

export function getMessage(id: string, opts?: { markRead?: boolean }) {
  const q = opts?.markRead ? '?markRead=true' : '';
  return panelGet<{ envelope: MessageEnvelope }>(`/messages/${encodeURIComponent(id)}${q}`);
}

function qs(p: URLSearchParams) { const s = p.toString(); return s ? `?${s}` : ''; }

export function getInstanceInbox(
  instanceId: string, opts?: { peek?: boolean; limit?: number },
): Promise<ApiResult<{ messages: InboxSummary[]; total: number }>> {
  const q = new URLSearchParams();
  if (opts?.peek !== undefined) q.set('peek', String(opts.peek));
  if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
  return panelGet(`/instances/${encodeURIComponent(instanceId)}/inbox${qs(q)}`);
}

export function getTeamMessages(
  teamId: string, opts?: { before?: string; limit?: number },
): Promise<ApiResult<{ items: InboxSummary[]; nextBefore: string | null; hasMore: boolean }>> {
  const q = new URLSearchParams();
  if (opts?.before) q.set('before', opts.before);
  if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
  return panelGet(`/teams/${encodeURIComponent(teamId)}/messages${qs(q)}`);
}
