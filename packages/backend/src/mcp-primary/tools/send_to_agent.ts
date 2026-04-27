// mteam-primary · send_to_agent
// Phase 4 扩展：kind 扩到 5 种；kind≠chat 且带 deadline 时同步建 ActionItem（creator=主 Agent）。
// 底层消息通路走 mcp/tools/send_msg#runSendMsg（不改底层，超集 kind 降级为 'task' 投递）。
import { runSendMsg } from '../../mcp/tools/send_msg.js';
import type { CommLike } from '../../mcp/comm-like.js';
import type { MteamEnv } from '../../mcp/config.js';
import type { PrimaryMcpEnv } from '../config.js';
import { createItem } from '../../action-item/repo.js';
import type { ActionItemKind } from '../../action-item/types.js';

const TOOL_KINDS = ['chat', 'task', 'approval', 'decision', 'authorization'] as const;
type ToolKind = (typeof TOOL_KINDS)[number];

export const sendToAgentSchema = {
  name: 'send_to_agent',
  description:
    'Primary Agent tool: send a message to any agent. "to" accepts an address, an alias/member_name, or an instanceId. Set kind≠chat + deadline to open an ActionItem.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Target: address, alias, member_name, or instanceId.' },
      content: { type: 'string', description: 'Full message body.' },
      summary: { type: 'string', maxLength: 200, description: 'Short summary; defaults to "给你发了一条消息".' },
      kind: { type: 'string', enum: TOOL_KINDS, description: 'Message kind; defaults to "chat".' },
      deadline: { type: 'number', description: 'Absolute ms epoch. Required to open an ActionItem when kind≠chat; must be > now + 1000.' },
      title: { type: 'string', maxLength: 200, description: 'ActionItem title when kind≠chat; defaults to summary/content slice.' },
      replyTo: { type: 'string', description: 'Optional envelope id this message replies to.' },
    },
    required: ['to', 'content'],
    additionalProperties: false,
  },
};

function toMteamEnv(env: PrimaryMcpEnv): MteamEnv {
  return { instanceId: env.instanceId, hubUrl: env.hubUrl, commSock: '', isLeader: false };
}

export async function runSendToAgent(
  env: PrimaryMcpEnv,
  comm: CommLike,
  args: {
    to?: unknown; content?: unknown; summary?: unknown; kind?: unknown;
    deadline?: unknown; title?: unknown; replyTo?: unknown;
  },
): Promise<unknown> {
  let kind: ToolKind = 'chat';
  if (args.kind !== undefined) {
    if (typeof args.kind !== 'string' || !(TOOL_KINDS as readonly string[]).includes(args.kind)) {
      return { error: `kind must be one of ${TOOL_KINDS.join('/')}` };
    }
    kind = args.kind as ToolKind;
  }
  const deadline = typeof args.deadline === 'number' && Number.isFinite(args.deadline) ? args.deadline : undefined;
  const wantItem = kind !== 'chat' && deadline !== undefined;
  if (wantItem && deadline! <= Date.now() + 1000) return { error: 'deadline must be > now + 1000ms' };

  // 底层只识 chat/task；approval/decision/authorization 按 task 投递，ActionItem 由本层补建。
  const wireKind: 'chat' | 'task' = kind === 'chat' ? 'chat' : 'task';
  const result = await runSendMsg(toMteamEnv(env), comm, { ...args, kind: wireKind });
  if (!wantItem || typeof result !== 'object' || result === null || !('delivered' in result)) return result;

  const to = (result as unknown as { to: string }).to;
  const assigneeId = to.includes(':') ? to.slice(to.indexOf(':') + 1) : to;
  const content = typeof args.content === 'string' ? args.content : '';
  const summary = typeof args.summary === 'string' && args.summary.length > 0 ? args.summary : undefined;
  const title = (typeof args.title === 'string' && args.title.length > 0 ? args.title : summary) ?? content.slice(0, 50);
  const item = createItem({
    kind: kind as ActionItemKind,
    title,
    description: content,
    creator: { kind: 'agent', id: env.instanceId },
    assignee: { kind: 'agent', id: assigneeId },
    deadline: deadline!,
  });
  return { ...result, actionItemId: item.id };
}
