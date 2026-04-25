import './NotificationCard.css';

interface NotificationCardProps {
  title: string;
  message: string;
  time: string;
  type?: 'info' | 'task' | 'error';
}

export default function NotificationCard({ title, message, time, type = 'info' }: NotificationCardProps) {
  return (
    <div className={`notif-card notif-card--${type}`}>
      <div className="notif-card__body">
        <div className="notif-card__title">{title}</div>
        <div className="notif-card__message">{message}</div>
      </div>
      <span className="notif-card__time">{time}</span>
    </div>
  );
}
