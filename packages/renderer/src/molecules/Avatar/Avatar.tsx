import type { ReactNode } from 'react';
import Logo from '../../atoms/Logo';
import StatusDot from '../../atoms/StatusDot';
import './Avatar.css';

export interface AvatarProps {
  /** 用户头像 URL；null/undefined → 回落到 Logo */
  src?: string | null;
  online?: boolean;
  size?: number;
  /** 右下角徽标：AgentLogo / 其它小图标。传入时替代 online 的 StatusDot */
  badge?: ReactNode;
  alt?: string;
}

export default function Avatar({ src, online, size = 56, badge, alt = '' }: AvatarProps) {
  return (
    <div className="avatar" style={{ width: size, height: size }}>
      {src ? (
        <img className="avatar__img" src={src} width={size} height={size} alt={alt} draggable={false} />
      ) : (
        <Logo size={size} />
      )}
      {badge ? (
        <span className="avatar__badge">{badge}</span>
      ) : online !== undefined ? (
        <StatusDot status={online ? 'online' : 'offline'} size="md" />
      ) : null}
    </div>
  );
}
