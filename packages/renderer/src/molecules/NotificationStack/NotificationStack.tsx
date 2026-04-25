import { useEffect, useRef, useState } from 'react';
import NotificationCard from '../../atoms/NotificationCard';
import './NotificationStack.css';

export interface Notification {
  id: string;
  title: string;
  message: string;
  time: string;
  type?: 'info' | 'task' | 'error';
}

interface NotificationStackProps {
  notifications: Notification[];
  onDismiss?: (id: string) => void;
  maxVisible?: number;
}

export default function NotificationStack({ notifications, onDismiss, maxVisible = 3 }: NotificationStackProps) {
  const [dismissing, setDismissing] = useState<Set<string>>(new Set());
  const prevIds = useRef<Set<string>>(new Set(notifications.map((n) => n.id)));
  const [entering, setEntering] = useState<Set<string>>(new Set());

  useEffect(() => {
    const current = new Set(notifications.map((n) => n.id));
    const next = new Set<string>();
    notifications.forEach((n) => { if (!prevIds.current.has(n.id)) next.add(n.id); });
    if (next.size) {
      setEntering((prev) => new Set([...prev, ...next]));
      requestAnimationFrame(() => requestAnimationFrame(() => setEntering(new Set())));
    }
    prevIds.current = current;
  }, [notifications]);

  const handleDismiss = (id: string) => {
    setDismissing((prev) => new Set(prev).add(id));
    setTimeout(() => {
      onDismiss?.(id);
      setDismissing((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }, 300);
  };

  const visible = notifications.slice(0, maxVisible);
  return (
    <div className="notif-stack" style={{ minHeight: 60 + Math.max(0, visible.length - 1) * 8 }}>
      {visible.map((n, i) => (
        <div
          key={n.id}
          className={`notif-stack__slot notif-stack__slot--${i}${dismissing.has(n.id) ? ' notif-stack__slot--dismissing' : ''}${entering.has(n.id) ? ' notif-stack__slot--entering' : ''}`}
        >
          <NotificationCard {...n} onDismiss={i === 0 ? () => handleDismiss(n.id) : undefined} />
        </div>
      ))}
    </div>
  );
}
