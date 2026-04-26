import Avatar from '../Avatar';
import MessageBubble from '../MessageBubble';
import MessageMeta from '../../atoms/MessageMeta';
import TypingDots from '../../atoms/TypingDots';
import ToolCallItem from '../../atoms/ToolCallItem';
import ToolCallList, { type ToolCall } from '../ToolCallList';
import type { TurnBlock } from '../../store/messageStore';
import './MessageRow.css';

interface MessageRowProps {
  role: 'agent' | 'user';
  content: string;
  time: string;
  read?: boolean;
  agentName?: string;
  thinking?: boolean;
  toolCalls?: ToolCall[];
  blocks?: TurnBlock[];
  streaming?: boolean;
}

function mapToolStatus(s?: string): 'running' | 'done' | 'error' {
  if (s === 'completed' || s === 'done') return 'done';
  if (s === 'failed' || s === 'error') return 'error';
  return 'running';
}

function renderBlock(block: TurnBlock, streaming: boolean) {
  switch (block.type) {
    case 'thinking':
      return <TypingDots key={block.blockId} />;
    case 'text':
      return (
        <span key={block.blockId} className="message-row__text-block">
          {block.content}{streaming && <span className="message-row__cursor" />}
        </span>
      );
    case 'tool_call':
    case 'tool_result':
      return (
        <ToolCallItem
          key={block.blockId}
          toolName={block.toolName ?? 'tool'}
          status={block.type === 'tool_result' ? 'done' : mapToolStatus(block.status)}
          summary={block.summary}
        />
      );
    default:
      return null;
  }
}

export default function MessageRow({
  role,
  content,
  time,
  read,
  agentName,
  thinking,
  toolCalls,
  blocks,
  streaming,
}: MessageRowProps) {
  const hasBlocks = blocks && blocks.length > 0;
  const variant = thinking ? 'thinking' : role;
  return (
    <div className={`message-row message-row--${role}`}>
      {role === 'agent' && (
        <div className="message-row__avatar">
          <Avatar size={32} online />
        </div>
      )}
      <div className="message-row__body">
        {hasBlocks ? (
          <div className="message-row__blocks">
            {blocks.map((b, i) => renderBlock(b, !!streaming && i === blocks.length - 1 && b.type === 'text'))}
          </div>
        ) : (
          <MessageBubble variant={variant} agentName={role === 'agent' ? agentName : undefined}>
            {content}
          </MessageBubble>
        )}
        {!thinking && !hasBlocks && (
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
