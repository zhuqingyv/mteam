import { useState } from 'react';
import TeamSidebarItem from '../../atoms/TeamSidebarItem';
import { useLocale } from '../../i18n';
import './TeamSidebar.css';

export interface TeamEntry {
  id: string;
  name: string;
  memberCount: number;
  unread?: number;
}

export interface TeamSidebarProps {
  teams: TeamEntry[];
  activeTeamId?: string;
  onSelectTeam?: (id: string) => void;
  onCreateTeam?: () => void;
  /** 受控：传入时外部驱动；未传则走内部 state（向后兼容） */
  collapsed?: boolean;
  /** 受控收起切换；传入才启用受控模式 */
  onToggleCollapsed?: () => void;
  /** 非受控模式的初始态；collapsed 已传时忽略 */
  defaultCollapsed?: boolean;
}

// 选择实际 collapsed 值：受控优先，否则走内部 state
export function resolveCollapsed(controlled: boolean | undefined, inner: boolean): boolean {
  return controlled !== undefined ? !!controlled : inner;
}

// TeamSidebar 根节点 className
export function getSidebarClassName(collapsed: boolean): string {
  const cls = ['tsb'];
  if (collapsed) cls.push('tsb--collapsed');
  return cls.join(' ');
}

// 未读 badge 显示值（<=0 → 不显示；>99 → '99+'；否则原值）
export function formatUnread(n: number | undefined): string | null {
  if (!n || n <= 0) return null;
  return n > 99 ? '99+' : String(n);
}

export default function TeamSidebar({
  teams,
  activeTeamId,
  onSelectTeam,
  onCreateTeam,
  collapsed,
  onToggleCollapsed,
  defaultCollapsed = false,
}: TeamSidebarProps) {
  const isControlled = collapsed !== undefined;
  const [inner, setInner] = useState(defaultCollapsed);
  const actual = resolveCollapsed(collapsed, inner);
  const { t } = useLocale();

  const toggle = () => {
    if (isControlled) onToggleCollapsed?.();
    else setInner((v) => !v);
  };

  const cls = getSidebarClassName(actual);
  const newTeamLabel = t('team.new_team');

  return (
    <aside className={cls}>
      <button
        className="tsb__toggle"
        onClick={toggle}
        title={actual ? t('common.expand') : t('common.collapse')}
      >
        {actual ? '»' : '«'}
      </button>
      <div className="tsb__list">
        {teams.map((team) => (
          <div key={team.id} className="tsb__row">
            <TeamSidebarItem
              name={team.name}
              memberCount={team.memberCount}
              active={team.id === activeTeamId}
              collapsed={actual}
              onClick={() => onSelectTeam?.(team.id)}
            />
            {formatUnread(team.unread) && (
              <span className="tsb__unread" aria-label={`${team.unread} unread`}>
                {formatUnread(team.unread)}
              </span>
            )}
          </div>
        ))}
        <button
          type="button"
          className="tsb__new"
          onClick={() => onCreateTeam?.()}
          title={newTeamLabel}
        >
          <span className="tsb__new-icon">+</span>
          {!actual && <span className="tsb__new-label">{newTeamLabel}</span>}
        </button>
      </div>
    </aside>
  );
}
