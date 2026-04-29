// S4-G2a：展开态节点主区内容 = 左 ChatList + 右 InstanceChatPanelConnected。
//
// 从 CanvasNodeExpanded 拆出，保持骨架是纯 molecule（children slot），装配走这层（organism-level）。
// 这个文件是胶水层，允许 import store / selector / organism。
//
// 行为：
// - activePeerId 默认 'user'；切换 peer → markPeerRead(iid, peerId) 清未读
// - peer=user → InstanceChatPanelConnected 走 ws.prompt 路径
// - peer !== 'user' → 输入框可用，点击发送触发"跨成员聊天即将上线" toast（见 InstanceChatPanelConnected）

import { useCallback, useMemo, useState } from 'react';
import ChatList from '../ChatList';
import { InstanceChatPanelConnected } from '../../organisms/InstanceChatPanel';
import { useMessageStore, useTeamStore, useAgentStore, usePrimaryAgentStore } from '../../store';
import { selectPeersFor, type InstanceChatSelectorState } from '../../store/selectors/instanceChat';
import type { ChatPeer } from '../../types/chat';
import './CanvasNodeChatBody.css';

export interface CanvasNodeChatBodyProps {
  instanceId: string;
  teamId?: string | null;
  userName?: string;
}

export default function CanvasNodeChatBody({
  instanceId,
  teamId = null,
  userName = 'You',
}: CanvasNodeChatBodyProps) {
  const [activePeerId, setActivePeerId] = useState<string>('user');

  // 用 shallow 等价策略：分别订阅 byInstance/teamMembers/agents/primaryInstanceId，
  // 然后在 useMemo 里合成 selector state —— 避免返回新对象引起 zustand 过度重渲染。
  const byInstance = useMessageStore((s) => s.byInstance);
  const teamMembers = useTeamStore((s) => s.teamMembers);
  const agents = useAgentStore((s) => s.agents);
  const leaderInstanceId = usePrimaryAgentStore((s) => s.instanceId);
  const markPeerRead = useMessageStore((s) => s.markPeerRead);

  const peers = useMemo<ChatPeer[]>(() => {
    const state: InstanceChatSelectorState = {
      byInstance,
      teamMembers,
      agents,
      leaderInstanceId,
    };
    return selectPeersFor(state, instanceId, teamId, userName);
  }, [byInstance, teamMembers, agents, leaderInstanceId, instanceId, teamId, userName]);

  const handleSelect = useCallback(
    (peerId: string) => {
      setActivePeerId(peerId);
      markPeerRead(instanceId, peerId);
    },
    [markPeerRead, instanceId],
  );

  const isUserPeer = activePeerId === 'user';
  const activePeer = peers.find((p) => p.id === activePeerId);

  return (
    <div className="canvas-node__chat-body">
      <div className="canvas-node__chat-list">
        <ChatList items={peers} activeId={activePeerId} onSelect={handleSelect} />
      </div>
      <div className="canvas-node__chat-panel">
        <InstanceChatPanelConnected
          instanceId={instanceId}
          peerId={activePeerId}
          peerName={activePeer?.name ?? activePeerId}
          emptyHint={isUserPeer ? '还没有消息，发条消息开始对话' : '跨成员聊天即将上线，先可以打字预览'}
        />
      </div>
    </div>
  );
}
