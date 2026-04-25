import NotificationCard from '../../atoms/NotificationCard';
import Button from '../../atoms/Button';
import Icon from '../../atoms/Icon';
import type { Notification } from '../../molecules/NotificationStack/NotificationStack';
import './NotificationCenter.css';

interface NotificationCenterProps {
  notifications: Notification[];
  open?: boolean;
  acknowledgedIds?: string[];
  onAcknowledge?: (id: string) => void;
  onClose?: () => void;
}

export default function NotificationCenter({
  notifications, open = true, acknowledgedIds = [], onAcknowledge, onClose,
}: NotificationCenterProps) {
  const ackSet = new Set(acknowledgedIds);
  const unread = notifications.filter((n) => !ackSet.has(n.id)).length;
  return (
    <aside className={`notif-center${open ? ' notif-center--open' : ''}`}>
      <header className="notif-center__head">
        <div className="notif-center__title">
          <span>Notifications</span>
          {unread > 0 && <span className="notif-center__badge">{unread}</span>}
        </div>
        <Button variant="icon" size="sm" onClick={onClose}><Icon name="close" size={16} /></Button>
      </header>
      <div className="notif-center__body">
        {notifications.length === 0 ? (
          <div className="notif-center__empty">No notifications</div>
        ) : (
          notifications.map((n) => {
            const read = ackSet.has(n.id);
            return (
              <button
                key={n.id}
                type="button"
                className={`notif-center__item${read ? ' notif-center__item--read' : ''}`}
                onClick={() => !read && onAcknowledge?.(n.id)}
              >
                <NotificationCard {...n} />
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
