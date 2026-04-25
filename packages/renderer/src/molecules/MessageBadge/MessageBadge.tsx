import './MessageBadge.css';

interface MessageBadgeProps {
  count: number;
  variant?: 'dot' | 'number';
}

export default function MessageBadge({ count, variant = 'number' }: MessageBadgeProps) {
  if (count <= 0) return null;
  if (variant === 'dot') {
    return <span className="badge badge--dot" />;
  }
  const label = count > 99 ? '99+' : String(count);
  return <span className="badge badge--number">{label}</span>;
}
