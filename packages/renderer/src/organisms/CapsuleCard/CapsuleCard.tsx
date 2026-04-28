import Logo, { type LogoStatus } from '../../atoms/Logo';
import StatusDot from '../../atoms/StatusDot';
import Button from '../../atoms/Button';
import Icon from '../../atoms/Icon';
import TitleBlock from '../../molecules/TitleBlock';
import MenuDots from '../../molecules/MenuDots';
import DragHandle from '../../molecules/DragHandle';
import { useLocale } from '../../i18n';
import './CapsuleCard.css';

interface CapsuleCardProps {
  name?: string;
  agentCount: number;
  taskCount: number;
  messageCount: number;
  online?: boolean;
  logoStatus?: LogoStatus;
  expanded?: boolean;
  animating?: boolean;
  bodyVisible?: boolean;
  onToggle?: () => void;
  children?: React.ReactNode;
}

export default function CapsuleCard({
  name = 'M-TEAM', agentCount, taskCount, messageCount, online, logoStatus,
  expanded = false, animating = false, bodyVisible = false, onToggle, children,
}: CapsuleCardProps) {
  const { t } = useLocale();
  const resolvedLogoStatus: LogoStatus = logoStatus ?? (online ? 'online' : 'offline');
  const subtitle = t('capsule.agents_tasks', { agents: agentCount, tasks: taskCount });
  const badgeText = messageCount > 0 ? t('capsule.new_messages', { count: messageCount }) : undefined;
  const cls = ['card'];
  if (expanded) cls.push('card--expanded');
  if (animating) cls.push('card--animating');
  if (bodyVisible) cls.push('card--body-visible');

  const handleCollapsedClick = () => {
    if (online === false) return;
    onToggle?.();
  };

  return (
    <div className={cls.join(' ')}>
      <div className="card__drag"><DragHandle /></div>
      <div className="card__logo"><Logo size={expanded ? 24 : 44} status={resolvedLogoStatus} /></div>
      {!expanded && (
        <div
          className="card__collapsed"
          onClick={handleCollapsedClick}
          role="button"
          tabIndex={online === false ? -1 : 0}
        >
          <TitleBlock title={name} subtitle={subtitle} badgeText={badgeText} badgeCount={messageCount} />
          <MenuDots asDragHandle />
        </div>
      )}
      <div className="card__expanded-head">
        <span className="card__expanded-name">{name}</span>
        <StatusDot status={online ? 'online' : 'offline'} size="sm" />
      </div>
      <div className="card__close">
        <Button variant="icon" size="sm" onClick={onToggle}>
          <Icon name="close" size={16} />
        </Button>
      </div>
      <div className="card__body">{children}</div>
    </div>
  );
}
