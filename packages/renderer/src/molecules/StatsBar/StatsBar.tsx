import type { ReactNode } from 'react';
import Surface from '../../atoms/Surface';
import StatusDot from '../../atoms/StatusDot';
import Icon from '../../atoms/Icon';
import './StatsBar.css';

export interface WorkersStats {
  total: number;
  online: number;
  idle: number;
  offline?: number;
}

export type StatKey = keyof WorkersStats;

interface StatsBarProps {
  stats: WorkersStats;
  onStatClick?: (key: StatKey) => void;
  activeKey?: StatKey | null;
}

interface Cell {
  key: StatKey;
  value: number;
  label: string;
  indicator: ReactNode;
}

export default function StatsBar({ stats, onStatClick, activeKey = null }: StatsBarProps) {
  const cells: Cell[] = [
    {
      key: 'total',
      value: stats.total,
      label: '成员总数',
      indicator: <Icon name="team" size={14} color="rgba(230, 237, 247, 0.78)" />,
    },
    {
      key: 'online',
      value: stats.online,
      label: '在线中',
      indicator: <StatusDot status="online" size="md" />,
    },
    {
      key: 'idle',
      value: stats.idle,
      label: '空闲中',
      indicator: <StatusDot status="busy" size="md" />,
    },
  ];

  if (typeof stats.offline === 'number') {
    cells.push({
      key: 'offline',
      value: stats.offline,
      label: '离线',
      indicator: <StatusDot status="offline" size="md" />,
    });
  }

  const clickable = Boolean(onStatClick);

  return (
    <Surface variant="panel" className="stats-bar">
      <div className="stats-bar__grid" role="group" aria-label="数字员工统计">
        {cells.map((cell, i) => {
          const active = activeKey === cell.key;
          const body = (
            <>
              <span className="stats-bar__icon" aria-hidden="true">
                {cell.indicator}
              </span>
              <span className="stats-bar__value">{cell.value}</span>
              <span className="stats-bar__label">{cell.label}</span>
            </>
          );
          return (
            <div key={cell.key} className="stats-bar__cell-wrap">
              {clickable ? (
                <button
                  type="button"
                  className={`stats-bar__cell stats-bar__cell--button${active ? ' stats-bar__cell--active' : ''}`}
                  data-key={cell.key}
                  aria-pressed={active}
                  onClick={() => onStatClick?.(cell.key)}
                >
                  {body}
                </button>
              ) : (
                <div className="stats-bar__cell" data-key={cell.key}>
                  {body}
                </div>
              )}
              {i < cells.length - 1 && <span className="stats-bar__divider" aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </Surface>
  );
}
