import type { ReactNode } from 'react';
import ChatPanel from '../ChatPanel';
import type { Message } from '../../types/chat';
import './InstanceChatPanel.css';

export interface InstanceChatPanelProps {
  instanceId: string;
  peerId: string;
  peerName: string;
  messages: Message[];
  streaming?: boolean;
  inputValue?: string;
  onInputChange?: (v: string) => void;
  onSend?: () => void;
  onStop?: () => void;
  headerSlot?: ReactNode;
  emptyHint?: string;
  disabled?: boolean;
}

export default function InstanceChatPanel({
  instanceId,
  peerId,
  peerName,
  messages,
  streaming = false,
  inputValue = '',
  onInputChange,
  onSend,
  onStop,
  headerSlot,
  emptyHint,
  disabled = false,
}: InstanceChatPanelProps) {
  const isEmpty = messages.length === 0;
  const handleInputChange = disabled ? undefined : onInputChange;
  const handleSend = disabled ? undefined : onSend;

  return (
    <div
      className="instance-chat-panel"
      data-instance-id={instanceId}
      data-peer-id={peerId}
      data-disabled={disabled || undefined}
    >
      {headerSlot ? <div className="instance-chat-panel__header">{headerSlot}</div> : null}
      {isEmpty && emptyHint ? (
        <div className="instance-chat-panel__empty" role="status">
          {emptyHint}
        </div>
      ) : null}
      <div className="instance-chat-panel__body" data-empty={isEmpty || undefined}>
        <ChatPanel
          messages={messages}
          agents={[]}
          inputPlaceholder={peerName ? `发送给 ${peerName}` : undefined}
          inputValue={inputValue}
          onInputChange={handleInputChange}
          onSend={handleSend}
          streaming={streaming}
          onStop={onStop}
        />
      </div>
    </div>
  );
}
