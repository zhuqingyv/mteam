// Phase 4 S4-M1：展开态节点左栏 peer 列表 + 单 peer 消息流 selector。
// 契约见 docs/phase4/INTERFACE-CONTRACTS.md §5 / §9 / §10。
// 纯函数，不 import store；调用方自己组装 state 切片。

import type { TeamMemberRow } from '../../api/teams';
import type { Agent } from '../agentStore';
import type { ChatPeer, Message, InstanceBucket } from '../../types/chat';

export interface InstanceChatSelectorState {
  teamMembers: Record<string, TeamMemberRow[]>;
  leaderInstanceId: string | null;
  leaderName?: string;
  agents: Agent[];
  byInstance: Record<string, InstanceBucket>;
}

const EMPTY_BUCKET: InstanceBucket = { messages: [], pendingPrompts: [] };

function findAgentName(agents: Agent[], iid: string): string | undefined {
  return agents.find((a) => a.id === iid)?.name;
}

function lastOf(messages: Message[], peerId: string): { text?: string; time?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.peerId === peerId) return { text: m.content, time: m.time };
  }
  return {};
}

/**
 * 节点 `instanceId` 展开态左栏 peer 列表：
 * - 总含 user
 * - 若 `leaderInstanceId` 存在且 !== instanceId，加 leader
 * - `teamId` 对应 team 的其它成员（排除自身、排除 leader 避免重复）
 */
export function selectPeersFor(
  state: InstanceChatSelectorState,
  instanceId: string,
  teamId: string | null,
  userName: string,
): ChatPeer[] {
  const bucket = state.byInstance[instanceId] ?? EMPTY_BUCKET;
  const peers: ChatPeer[] = [];

  const userLast = lastOf(bucket.messages, 'user');
  peers.push({
    id: 'user',
    name: userName,
    role: 'user',
    lastMessage: userLast.text,
    lastTime: userLast.time,
  });

  const leaderId = state.leaderInstanceId;
  if (leaderId && leaderId !== instanceId) {
    const leaderLast = lastOf(bucket.messages, leaderId);
    peers.push({
      id: leaderId,
      name: state.leaderName ?? findAgentName(state.agents, leaderId) ?? 'Leader',
      role: 'leader',
      lastMessage: leaderLast.text,
      lastTime: leaderLast.time,
    });
  }

  const members = teamId ? (state.teamMembers[teamId] ?? []) : [];
  for (const m of members) {
    if (m.instanceId === instanceId) continue;
    if (leaderId && m.instanceId === leaderId) continue;
    const last = lastOf(bucket.messages, m.instanceId);
    peers.push({
      id: m.instanceId,
      name: m.roleInTeam ?? findAgentName(state.agents, m.instanceId) ?? m.instanceId,
      role: 'member',
      lastMessage: last.text,
      lastTime: last.time,
    });
  }

  return peers;
}

/**
 * 某 instance 桶里属于某 peer 的消息流。
 * 匹配规则（按契约 §10.3）：
 * - peer='user'：`peerId === 'user'`（用户 turn 气泡 / comm user→agent）
 * - peer=对方 instanceId：`peerId === <对方 instanceId>`
 * - 无 `peerId` 的历史 turn 消息向后兼容：归到 peer='user'
 */
export function selectMessagesForPeer(
  state: Pick<InstanceChatSelectorState, 'byInstance'>,
  instanceId: string,
  peerId: string,
): Message[] {
  const bucket = state.byInstance[instanceId] ?? EMPTY_BUCKET;
  return bucket.messages.filter((m) => {
    if (m.peerId != null) return m.peerId === peerId;
    if (peerId === 'user') {
      return m.kind === 'turn' || m.kind == null;
    }
    return false;
  });
}
