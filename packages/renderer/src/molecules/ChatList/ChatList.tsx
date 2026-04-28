import ChatListItem from './ChatListItem';
import type { ChatPeer } from '../../types/chat';
import './ChatList.css';

interface ChatListProps {
  items: ChatPeer[];
  activeId?: string;
  onSelect?: (id: string) => void;
  collapsed?: boolean;
  emptyHint?: string;
}

export default function ChatList({
  items,
  activeId,
  onSelect,
  collapsed = false,
  emptyHint = 'No chats yet',
}: ChatListProps) {
  const cls = ['chat-list'];
  if (collapsed) cls.push('chat-list--collapsed');
  return (
    <div className={cls.join(' ')}>
      <div className="chat-list__items" role="list">
        {items.length === 0 ? (
          <div className="chat-list__empty">{emptyHint}</div>
        ) : (
          items.map((p) => (
            <ChatListItem
              key={p.id}
              peer={p}
              active={p.id === activeId}
              onClick={() => onSelect?.(p.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
