import Icon from '../Icon';
import './MessageMeta.css';

interface MessageMetaProps {
  time: string;
  read?: boolean;
}

export default function MessageMeta({ time, read }: MessageMetaProps) {
  return (
    <span className="message-meta">
      <span className="message-meta__time">{time}</span>
      {read && <Icon name="check-double" size={14} color="rgba(74,163,255,0.8)" />}
    </span>
  );
}
