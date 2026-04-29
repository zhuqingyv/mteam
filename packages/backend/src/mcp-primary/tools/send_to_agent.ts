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
    '给团队里的任何人发消息：普通聊天、派任务、请求审批或授权。' +
    'to 可以填对方的显示名、备注名或地址。kind≠chat 并带 deadline 时，会自动生成一条待办交给对方跟进。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: '发给谁：可填对方的显示名、备注名或地址。' },
      content: { type: 'string', description: '消息正文。' },
      summary: { type: 'string', maxLength: 200, description: '简短摘要；默认“给你发了一条消息”。' },
      kind: { type: 'string', enum: TOOL_KINDS, description: '消息类型：chat 闲聊 / task 任务 / approval 审批 / decision 决策 / authorization 授权。默认 chat。' },
      deadline: { type: 'number', description: '截止时间（绝对毫秒时间戳）。kind≠chat 时填写才会创建待办，必须大于当前时间 1 秒以上。' },
      title: { type: 'string', maxLength: 200, description: '待办标题（kind≠chat 时使用），不填则取 summary 或 content 的前 50 字。' },
      replyTo: { type: 'string', description: '回复哪条消息（可选，填对方的消息 id）。' },
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
