import logoSrc from '../../assets/logo-m.png';
import './Logo.css';

export type LogoStatus = 'online' | 'connecting' | 'offline';

interface LogoProps {
  size?: number;
  status?: LogoStatus;
  /** @deprecated 用 status 替代；true→online，false→offline */
  online?: boolean;
}

export default function Logo({ size = 56, status, online }: LogoProps) {
  const resolved: LogoStatus = status ?? (online === false ? 'offline' : 'online');
  const shift = Math.max(1, Math.round(size * 0.06));
  return (
    <img
      src={logoSrc}
      width={size}
      height={size}
      alt="M"
      className={`logo logo--${resolved}`}
      style={{ transform: `translateY(${shift}px)` }}
    />
  );
}
