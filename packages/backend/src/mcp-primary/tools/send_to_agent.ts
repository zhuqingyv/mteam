// mteam-primary · send_to_agent
// 主 Agent 专用跨团队通信入口。直接复用 mteam/send_msg 的 runSendMsg 核心逻辑，
// 只是把入口 env 从 MteamEnv（包含 commSock / isLeader）收窄到 PrimaryMcpEnv。
// from 身份由底层 CommLike 实现决定（构造时绑定 instanceId），这里不处理。
import { runSendMsg } from '../../mcp/tools/send_msg.js';
import type { CommLike } from '../../mcp/comm-like.js';
import type { MteamEnv } from '../../mcp/config.js';
import type { PrimaryMcpEnv } from '../config.js';

export const sendToAgentSchema = {
  name: 'send_to_agent',
  description:
    'Primary Agent tool: send a message to any agent (leader or member). "to" accepts an address (e.g. "local:<id>"), an alias/member_name, or an instanceId.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Target: address, alias, member_name, or instanceId.' },
      content: { type: 'string', description: 'Full message body.' },
      summary: { type: 'string', maxLength: 200, description: 'Short summary; defaults to "给你发了一条消息".' },
      kind: { type: 'string', enum: ['chat', 'task'], description: 'Message kind; defaults to "chat".' },
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
  args: { to?: unknown; content?: unknown; summary?: unknown; kind?: unknown; replyTo?: unknown },
): Promise<unknown> {
  return runSendMsg(toMteamEnv(env), comm, args);
}
