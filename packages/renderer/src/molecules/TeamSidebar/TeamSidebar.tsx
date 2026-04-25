import { useState } from 'react';
import TeamSidebarItem from '../../atoms/TeamSidebarItem';
import './TeamSidebar.css';

interface Team { id: string; name: string; memberCount: number; }
interface TeamSidebarProps {
  teams: Team[];
  activeTeamId?: string;
  onSelectTeam?: (id: string) => void;
  defaultCollapsed?: boolean;
}

export default function TeamSidebar({
  teams, activeTeamId, onSelectTeam, defaultCollapsed = false,
}: TeamSidebarProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const cls = ['tsb'];
  if (collapsed) cls.push('tsb--collapsed');
  return (
    <aside className={cls.join(' ')}>
      <button className="tsb__toggle" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开' : '收起'}>
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
      </div>
    </aside>
  );
}
