import Logo from '../../atoms/Logo';
import StatusDot from '../../atoms/StatusDot';
import './Avatar.css';

interface AvatarProps {
  online?: boolean;
  size?: number;
}

export default function Avatar({ online, size = 56 }: AvatarProps) {
  return (
    <div className="avatar">
      <Logo size={size} />
      {online !== undefined && (
        <StatusDot status={online ? 'online' : 'offline'} size="md" />
      )}
    </div>
  );
}
