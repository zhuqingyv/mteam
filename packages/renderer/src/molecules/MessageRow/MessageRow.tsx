import Avatar from '../Avatar';
import MessageBubble from '../MessageBubble';
import MessageMeta from '../../atoms/MessageMeta';
import ToolCallList, { type ToolCall } from '../ToolCallList';
import './MessageRow.css';

interface MessageRowProps {
  role: 'agent' | 'user';
  content: string;
  time: string;
  read?: boolean;
  agentName?: string;
  thinking?: boolean;
  toolCalls?: ToolCall[];
}

export default function MessageRow({
  role,
  content,
  time,
  read,
  agentName,
  thinking,
  toolCalls,
}: MessageRowProps) {
  const variant = thinking ? 'thinking' : role;
  return (
    <div className={`message-row message-row--${role}`}>
      {role === 'agent' && (
        <div className="message-row__avatar">
          <Avatar size={32} online />
        </div>
      )}
      <div className="message-row__body">
        <MessageBubble variant={variant} agentName={role === 'agent' ? agentName : undefined}>
          {content}
        </MessageBubble>
        {!thinking && (
          <div className="message-row__meta">
            <MessageMeta time={time} read={role === 'user' ? read : undefined} />
          </div>
        )}
        {role === 'agent' && toolCalls && toolCalls.length > 0 && (
          <div className="message-row__tools">
            <ToolCallList calls={toolCalls} />
          </div>
        )}
      </div>
    </div>
  );
}
