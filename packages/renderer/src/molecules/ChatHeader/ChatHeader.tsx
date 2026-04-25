import Logo from '../../atoms/Logo';
import StatusDot from '../../atoms/StatusDot';
import Icon from '../../atoms/Icon';
import './ChatHeader.css';

interface ChatHeaderProps {
  name?: string;
  online?: boolean;
  onClose?: () => void;
}

export default function ChatHeader({ name = 'M-TEAM', online = true, onClose }: ChatHeaderProps) {
  return (
    <div className="chat-header">
      <div className="chat-header__left">
        <Logo size={28} />
        <span className="chat-header__name">{name}</span>
        <StatusDot status={online ? 'online' : 'offline'} size="sm" />
      </div>
      <button
        type="button"
        className="chat-header__close"
        aria-label="关闭"
        onClick={onClose}
      >
        <Icon name="close" size={16} color="rgba(230,237,247,0.7)" />
      </button>
    </div>
  );
}
