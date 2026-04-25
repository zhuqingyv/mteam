import './TeamSidebarItem.css';

interface TeamSidebarItemProps {
  name: string;
  memberCount: number;
  active?: boolean;
  collapsed?: boolean;
  onClick?: () => void;
}

export default function TeamSidebarItem({
  name, memberCount, active, collapsed, onClick,
}: TeamSidebarItemProps) {
  const cls = ['tsi'];
  if (active) cls.push('tsi--active');
  if (collapsed) cls.push('tsi--collapsed');
  const initial = name.charAt(0).toUpperCase();
  return (
    <button className={cls.join(' ')} onClick={onClick} title={name}>
      <span className="tsi__icon">{initial}</span>
      {!collapsed && (
        <span className="tsi__body">
          <span className="tsi__name">{name}</span>
          <span className="tsi__meta">{memberCount} members</span>
        </span>
      )}
    </button>
  );
}
