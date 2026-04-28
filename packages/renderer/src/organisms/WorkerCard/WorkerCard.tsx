import { useState } from 'react';
import Button from '../../atoms/Button';
import Icon from '../../atoms/Icon';
import Logo from '../../atoms/Logo';
import StatusDot from '../../atoms/StatusDot';
import Tag from '../../atoms/Tag';
import './WorkerCard.css';

export type WorkerStatus = 'online' | 'idle' | 'offline';

export interface WorkerLastActivity {
  summary: string;
  ts: string;
}

export interface WorkerCardProps {
  name: string;
  role: string;
  description: string;
  avatar: string | null;
  status: WorkerStatus;
  mcps: string[];
  instanceCount: number;
  lastActivity?: WorkerLastActivity | null;
  teams?: string[];
  onChat?: () => void;
  onViewMore?: (action: 'detail' | 'activity') => void;
}

const STATUS_LABEL: Record<WorkerStatus, string> = {
  online: '在线',
  idle: '空闲',
  offline: '离线',
};

const STATUS_DOT: Record<WorkerStatus, 'online' | 'busy' | 'offline'> = {
  online: 'online',
  idle: 'busy',
  offline: 'offline',
};

function resolveAvatarUrl(id: string | null): string | null {
  if (!id) return null;
  if (/^avatar-\d{2}$/.test(id)) {
    return new URL(`../../assets/avatars/${id}.png`, import.meta.url).href;
  }
  return `/avatars/${id}.png`;
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const ch = Array.from(trimmed)[0] ?? '?';
  return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
}

export default function WorkerCard({
  name,
  role,
  description,
  avatar,
  status,
  mcps,
  instanceCount,
  lastActivity,
  teams,
  onChat,
  onViewMore,
}: WorkerCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const avatarUrl = resolveAvatarUrl(avatar);
  const mcpHead = mcps.slice(0, 3);
  const mcpRest = mcps.length - mcpHead.length;
  const lastTeam = teams && teams.length > 0 ? teams[0] : null;
  const activityText = lastActivity?.summary ?? (lastTeam ? `所在团队：${lastTeam}` : '暂无协作记录');

  return (
    <article className={`worker-card worker-card--${status}`} aria-label={`${name} 员工卡片`}>
      <header className="worker-card__head">
        <div className="worker-card__avatar">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={avatar ?? name}
              className="worker-card__avatar-img"
              draggable={false}
            />
          ) : (
            <div className="worker-card__avatar-fallback" aria-hidden>
              {initialOf(name)}
            </div>
          )}
        </div>
        <div className="worker-card__identity">
          <div className="worker-card__name-row">
            <span className="worker-card__name" title={name}>{name}</span>
            <span className="worker-card__status-chip" data-status={status}>
              <StatusDot status={STATUS_DOT[status]} size="sm" />
              <span className="worker-card__status-text">{STATUS_LABEL[status]}</span>
            </span>
          </div>
          <div className="worker-card__role" title={role}>{role}</div>
        </div>
      </header>

      <p className="worker-card__desc" title={description}>{description}</p>

      {mcps.length > 0 && (
        <div className="worker-card__mcps" aria-label="可用 MCP">
          {mcpHead.map((m) => (
            <Tag key={m} label={m} size="sm" />
          ))}
          {mcpRest > 0 && (
            <span className="worker-card__mcps-more">+{mcpRest}</span>
          )}
        </div>
      )}

      <footer className="worker-card__footer">
        <div className="worker-card__activity" title={activityText}>
          <span className="worker-card__activity-icon" aria-hidden>
            <Icon name="team" size={12} color="rgba(230, 237, 247, 0.72)" />
          </span>
          <span className="worker-card__activity-logo" aria-hidden>
            <Logo size={14} />
          </span>
          <span className="worker-card__activity-text">{activityText}</span>
          {instanceCount > 0 && (
            <span className="worker-card__instances" aria-label={`实例数 ${instanceCount}`}>×{instanceCount}</span>
          )}
        </div>
        <div className="worker-card__actions" onClick={(e) => e.stopPropagation()}>
          {onChat && (
            <Button variant="icon" size="sm" onClick={onChat}>
              <span className="worker-card__action-label">
                <Icon name="send" size={12} />
              </span>
            </Button>
          )}
          {onViewMore && (
            <div className="worker-card__more">
              <Button variant="dots" size="sm" onClick={() => setMenuOpen((v) => !v)} />
              {menuOpen && (
                <div className="worker-card__menu" role="menu">
                  <button
                    type="button"
                    className="worker-card__menu-item"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); onViewMore('detail'); }}
                  >
                    查看详情
                  </button>
                  <button
                    type="button"
                    className="worker-card__menu-item"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); onViewMore('activity'); }}
                  >
                    工作统计
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </footer>
    </article>
  );
}
