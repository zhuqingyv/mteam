// S3-G1 容器组件：把 InstanceChatPanel 这个纯 props-driven organism 接到 messageStore +
// promptDispatcher + useInstancePanel（订阅/热快照）。对外只暴露 instanceId，一行接入即可。
//
// 范围：peer='user' 单一对话（节点自己和用户的对话）。跨 agent peer 路径由 S4-G2a / S4-G4 接。
// 输入 state 走本地 useState（契约允许两种之一；inputStore per-iid 在契约上未冻结，
// 本阶段走本地 state 足够）。
//
// 契约：INTERFACE-CONTRACTS §5.2 / §10.1；任务：TASK-LIST S3-G1。

import { useCallback, useState } from 'react';
import InstanceChatPanel from './InstanceChatPanel';
import { useMessageStore } from '../../store/messageStore';
import { selectMessagesFor } from '../../store/messageStore.selectors';
import type { Message } from '../../types/chat';
import {
  sendUserPrompt,
  cancelCurrentTurn,
  isTurnStreaming,
} from '../../hooks/promptDispatcher';
import { useInstancePanel } from '../../hooks/useInstancePanel';

// 从桶消息列表派生 streaming 态：存在 role=agent + streaming + turnId 的消息 → streaming。
// 纯函数便于单测。判定口径必须和 promptDispatcher.isTurnStreaming 一致（契约 §4.2）。
export function deriveStreaming(messages: Message[]): boolean {
  return messages.some((m) => m.role === 'agent' && m.streaming === true && !!m.turnId);
}

// 发送决策：peer='user' 走 ws.prompt（契约 §10.1）；其它 peer 当前不支持，no-op。
// S4-G4 会扩成 peer!==user 时走 sendAgentMessage。
export type SendDecision = 'user-prompt' | 'agent-message' | 'noop';

export function decideSendPath(peerId: string, text: string): SendDecision {
  if (!text.trim()) return 'noop';
  if (peerId === 'user') return 'user-prompt';
  return 'agent-message';
}

export interface InstanceChatPanelConnectedProps {
  instanceId: string;
  peerId?: string;        // 默认 'user'；跨 agent peer 路径（S4）会传对方 instanceId
  peerName?: string;      // 默认 instanceId，给 ChatPanel 输入框占位用
  emptyHint?: string;
  disabled?: boolean;
}

export default function InstanceChatPanelConnected({
  instanceId,
  peerId = 'user',
  peerName,
  emptyHint,
  disabled = false,
}: InstanceChatPanelConnectedProps) {
  // 登记 instance 订阅 + 挂载时拉一次 get_turns 热快照。
  useInstancePanel(instanceId);

  // 订阅桶消息。selector 对缺失桶返回共享 EMPTY 引用，避免不必要的 rerender。
  const messages = useMessageStore((s) => selectMessagesFor(s, instanceId));
  // streaming 态从同一桶派生，口径与 isTurnStreaming 对齐。
  const streaming = useMessageStore((s) => deriveStreaming(selectMessagesFor(s, instanceId)));

  const [inputValue, setInputValue] = useState('');

  const handleSend = useCallback(() => {
    const decision = decideSendPath(peerId, inputValue);
    if (decision === 'user-prompt') {
      sendUserPrompt(inputValue.trim(), instanceId);
      setInputValue('');
    }
    // 'agent-message' 路径留给 S4-G4 接入 sendAgentMessage；现阶段不发送。
    // 'noop' 路径（纯空白）不做任何事。
  }, [inputValue, instanceId, peerId]);

  const handleStop = useCallback(() => {
    if (!isTurnStreaming(instanceId)) return;
    cancelCurrentTurn(instanceId);
  }, [instanceId]);

  return (
    <InstanceChatPanel
      instanceId={instanceId}
      peerId={peerId}
      peerName={peerName ?? instanceId}
      messages={messages}
      streaming={streaming}
      inputValue={inputValue}
      onInputChange={setInputValue}
      onSend={handleSend}
      onStop={handleStop}
      emptyHint={emptyHint}
      disabled={disabled}
    />
  );
}
