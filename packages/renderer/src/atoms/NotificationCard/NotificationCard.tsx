import './NotificationCard.css';

interface NotificationCardProps {
  title: string;
  message: string;
  time: string;
  type?: 'info' | 'task' | 'error';
  onDismiss?: () => void;
}

export default function NotificationCard({ title, message, time, type = 'info', onDismiss }: NotificationCardProps) {
  return (
    <div className={`notif-card notif-card--${type}`}>
      <div className="notif-card__body">
        <div className="notif-card__title">{title}</div>
        <div className="notif-card__message">{message}</div>
      </div>
      <span className="notif-card__time">{time}</span>
      {onDismiss && (
        <button type="button" className="notif-card__dismiss" onClick={onDismiss} aria-label="dismiss">
          ×
        </button>
      )}
    </div>
  );
}
