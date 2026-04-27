import { useEffect, useRef, useState } from 'react';
import NotificationCard from '../../atoms/NotificationCard';
import Icon from '../../atoms/Icon';
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
  acknowledgedIds?: string[];
  maxVisible?: number;
}

type Phase = 'check' | 'fade' | 'slide';

export default function NotificationStack({ notifications, acknowledgedIds = [], maxVisible = 3 }: NotificationStackProps) {
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  const prevIds = useRef<Set<string>>(new Set(notifications.map((n) => n.id)));
  const [entering, setEntering] = useState<Set<string>>(new Set());
  const ackSet = useRef<Set<string>>(new Set());

  useEffect(() => {
    const next = new Set<string>();
    notifications.forEach((n) => { if (!prevIds.current.has(n.id)) next.add(n.id); });
    if (next.size) {
      setEntering((prev) => new Set([...prev, ...next]));
      requestAnimationFrame(() => requestAnimationFrame(() => setEntering(new Set())));
    }
    prevIds.current = new Set(notifications.map((n) => n.id));
  }, [notifications]);

  useEffect(() => {
    acknowledgedIds.forEach((id) => {
      if (ackSet.current.has(id)) return;
      ackSet.current.add(id);
      setPhases((p) => ({ ...p, [id]: 'check' }));
      setTimeout(() => setPhases((p) => ({ ...p, [id]: 'fade' })), 320);
      setTimeout(() => setPhases((p) => ({ ...p, [id]: 'slide' })), 620);
    });
  }, [acknowledgedIds]);

  const visible = notifications.slice(0, maxVisible);
  return (
    <div className="notif-stack" style={{ minHeight: 60 + Math.max(0, visible.length - 1) * 8 }}>
      {visible.map((n, i) => {
        const phase = phases[n.id];
        const slotCls = [
          'notif-stack__slot',
          `notif-stack__slot--${i}`,
          entering.has(n.id) ? 'notif-stack__slot--entering' : '',
          phase === 'fade' ? 'notif-stack__slot--fading' : '',
          phase === 'slide' ? 'notif-stack__slot--sliding' : '',
        ].filter(Boolean).join(' ');
        return (
          <div key={n.id} className={slotCls}>
            <NotificationCard {...n} />
            {phase === 'check' && (
              <span className="notif-stack__check" aria-label="acknowledged">
                <Icon name="check" size={18} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
