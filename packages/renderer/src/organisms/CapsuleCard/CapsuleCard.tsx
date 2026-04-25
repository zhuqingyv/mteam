import Logo from '../../atoms/Logo';
import StatusDot from '../../atoms/StatusDot';
import TitleBlock from '../../molecules/TitleBlock';
import MenuDots from '../../molecules/MenuDots';
import './CapsuleCard.css';

interface CapsuleCardProps {
  name?: string;
  agentCount: number;
  taskCount: number;
  messageCount: number;
  online?: boolean;
  expanded?: boolean;
  animating?: boolean;
  onToggle?: () => void;
}

export default function CapsuleCard({
  name = 'M-TEAM', agentCount, taskCount, messageCount, online,
  expanded = false, animating = false, onToggle,
}: CapsuleCardProps) {
  const cls = ['card'];
  if (expanded) cls.push('card--expanded');
  if (animating) cls.push('card--animating');

  return (
    <div className={cls.join(' ')}>
      <div className="card__drag"><div className="card__drag-pill" /></div>
      <div className="card__logo"><Logo size={expanded ? 24 : 44} online={online} /></div>
      <div className="card__collapsed">
        <TitleBlock title={name} subtitle={`${agentCount} Agents · ${taskCount} Tasks`} badgeText={`${messageCount} New messages`} badgeCount={messageCount} />
        <MenuDots onClick={onToggle} />
      </div>
      <div className="card__expanded-head">
        <span className="card__expanded-name">{name}</span>
        <StatusDot status="online" size="sm" />
      </div>
      <button className="card__close" onClick={onToggle}>×</button>
      <div className="card__body" />
    </div>
  );
}
