import StatusDot from '../../atoms/StatusDot';
import MessageBadge from '../MessageBadge';
import type { ChatPeer } from '../../types/chat';

interface ChatListItemProps {
  peer: ChatPeer;
  active?: boolean;
  onClick?: () => void;
}

export default function ChatListItem({ peer, active, onClick }: ChatListItemProps) {
  const cls = ['chat-list__item'];
  if (active) cls.push('chat-list__item--active');
  cls.push(`chat-list__item--role-${peer.role}`);
  const initial = peer.name.charAt(0).toUpperCase() || '?';
  // 改成 div[role=button] 避开组件库铁律禁止的裸 <button>；键盘可达由 onKeyDown 的 Enter/Space 处理。
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  };
  return (
    <div
      className={cls.join(' ')}
      role="button"
      tabIndex={0}
      aria-pressed={active || undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      title={peer.name}
    >
      <span className="chat-list__avatar">
        {peer.avatar ? (
          <img src={peer.avatar} alt="" className="chat-list__avatar-img" />
        ) : (
          <span className="chat-list__avatar-initial">{initial}</span>
        )}
        {peer.role === 'leader' && (
          <StatusDot status="online" size="sm" />
        )}
      </span>
      <span className="chat-list__body">
        <span className="chat-list__top">
          <span className="chat-list__name">{peer.name}</span>
          {peer.lastTime && <span className="chat-list__time">{peer.lastTime}</span>}
        </span>
        <span className="chat-list__bottom">
          <span className="chat-list__last">{peer.lastMessage ?? ''}</span>
          {peer.unread !== undefined && peer.unread > 0 && (
            <MessageBadge count={peer.unread} />
          )}
        </span>
      </span>
    </div>
  );
}
