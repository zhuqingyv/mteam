import './StatusDot.css';

interface StatusDotProps {
  status?: 'online' | 'busy' | 'offline';
  size?: 'sm' | 'md' | 'lg';
}

export default function StatusDot({ status = 'online', size = 'md' }: StatusDotProps) {
  return <span className={`status-dot status-dot--${size} status-dot--${status}`} />;
}
