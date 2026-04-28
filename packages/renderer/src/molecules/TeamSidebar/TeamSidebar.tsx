import { useState } from 'react';
import TeamSidebarItem from '../../atoms/TeamSidebarItem';
import { useLocale } from '../../i18n';
import './TeamSidebar.css';

interface Team { id: string; name: string; memberCount: number; }
interface TeamSidebarProps {
  teams: Team[];
  activeTeamId?: string;
  onSelectTeam?: (id: string) => void;
  onCreateTeam?: () => void;
  defaultCollapsed?: boolean;
}

export default function TeamSidebar({
  teams, activeTeamId, onSelectTeam, onCreateTeam, defaultCollapsed = false,
}: TeamSidebarProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const { t } = useLocale();
  const cls = ['tsb'];
  if (collapsed) cls.push('tsb--collapsed');
  const newTeamLabel = t('team.new_team');
  return (
    <aside className={cls.join(' ')}>
      <button className="tsb__toggle" onClick={() => setCollapsed(!collapsed)} title={collapsed ? t('common.expand') : t('common.collapse')}>
        {collapsed ? '»' : '«'}
      </button>
      <div className="tsb__list">
        {teams.map((t) => (
          <TeamSidebarItem
            key={t.id}
            name={t.name}
            memberCount={t.memberCount}
            active={t.id === activeTeamId}
            collapsed={collapsed}
            onClick={() => onSelectTeam?.(t.id)}
          />
        ))}
        <button
          type="button"
          className="tsb__new"
          onClick={() => onCreateTeam?.()}
          title={newTeamLabel}
        >
          <span className="tsb__new-icon">+</span>
          {!collapsed && <span className="tsb__new-label">{newTeamLabel}</span>}
        </button>
      </div>
    </aside>
  );
}
