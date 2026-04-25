import type { ReactNode } from 'react';
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
          <span className="bubble__dots" aria-label="typing">
            <i />
            <i />
            <i />
          </span>
        ) : (
          <div className="bubble__body">{children}</div>
        )}
        {time && variant !== 'thinking' && (
          <div className="bubble__meta">
            <span>{time}</span>
            {variant === 'user' && read && <span className="bubble__read">read</span>}
          </div>
        )}
      </div>
    </div>
  );
}
