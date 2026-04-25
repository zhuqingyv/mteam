import MessageRow from '../../molecules/MessageRow';
import AgentSwitcher from '../../molecules/AgentSwitcher';
import ChatInput from '../../molecules/ChatInput';
import VirtualList from '../../atoms/VirtualList';
import type { ToolCall } from '../../molecules/ToolCallList';
import './ChatPanel.css';

interface Message {
  id: string;
  role: 'agent' | 'user';
  content: string;
  time: string;
  read?: boolean;
  agentName?: string;
  thinking?: boolean;
  toolCalls?: ToolCall[];
}

interface Agent {
  id: string;
  name: string;
  active?: boolean;
}

interface ChatPanelProps {
  messages?: Message[];
  agents?: Agent[];
  inputPlaceholder?: string;
}

export default function ChatPanel({
  messages = [],
  agents = [],
  inputPlaceholder = '给 MTEAM 发送消息...',
}: ChatPanelProps) {
  const activeId = agents.find((a) => a.active)?.id;
  return (
    <div className="chat-panel">
      <div className="chat-panel__messages">
        <VirtualList
          items={messages}
          getKey={(m) => m.id}
          renderItem={(m) => (
            <div className="chat-panel__row">
              <MessageRow
                role={m.role}
                content={m.content}
                time={m.time}
                read={m.read}
                agentName={m.agentName}
                thinking={m.thinking}
                toolCalls={m.toolCalls}
              />
            </div>
          )}
        />
      </div>
      <div className="chat-panel__footer">
        <AgentSwitcher agents={agents} activeId={activeId} />
        <ChatInput placeholder={inputPlaceholder} value="" />
      </div>
    </div>
  );
}
