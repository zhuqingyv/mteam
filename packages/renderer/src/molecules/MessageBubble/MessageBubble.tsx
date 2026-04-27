import type { ReactNode } from 'react';
import TypingDots from '../../atoms/TypingDots';
import MessageMeta from '../../atoms/MessageMeta';
import './MessageBubble.css';

interface MessageBubbleProps {
  variant: 'agent' | 'user' | 'thinking';
  children?: ReactNode;
  time?: string;
  read?: boolean;
  agentName?: string;
}

export default function MessageBubble({
  variant,
  children,
  time,
  read,
  agentName,
}: MessageBubbleProps) {
  return (
    <div className={`bubble-row bubble-row--${variant}`}>
      <div className={`bubble bubble--${variant}`}>
        {agentName && variant === 'agent' && (
          <div className="bubble__name">{agentName}</div>
        )}
        {variant === 'thinking' ? (
          <TypingDots color="rgba(255, 255, 255, 0.92)" />
        ) : (
          <div className="bubble__body">{children}</div>
        )}
        {time && variant !== 'thinking' && (
          <div className="bubble__meta">
            <MessageMeta time={time} read={variant === 'user' ? read : undefined} />
          </div>
        )}
      </div>
    </div>
  );
}
