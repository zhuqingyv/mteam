import { useMemo } from 'react';
import TabFilter from '../../molecules/TabFilter';
import StatsBar from '../../molecules/StatsBar';
import WorkerCard from '../WorkerCard';
import type { WorkerView } from '../../api/ws-protocol';
import './WorkerListPanel.css';

export type WorkerListTab = 'all' | 'template' | 'online';

interface WorkerListPanelProps {
  workers: WorkerView[];
  stats: { total: number; online: number; idle: number; offline: number };
  tab: WorkerListTab;
  onTabChange: (tab: WorkerListTab) => void;
  searchQuery: string;
  loading?: boolean;
  onChat?: (name: string) => void;
  onViewMore?: (name: string, action: 'detail' | 'activity') => void;
}

// 运行时员工筛选（前端本地）。
// - all：全部
// - template：展示所有模板，即全量（workers = templates，只读展示层）
// - online：status === 'online'
function applyTab(list: WorkerView[], tab: WorkerListTab): WorkerView[] {
  if (tab === 'online') return list.filter((w) => w.status === 'online');
  return list;
}

function applySearch(list: WorkerView[], query: string): WorkerView[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((w) => {
    if (w.name.toLowerCase().includes(q)) return true;
    if (w.role.toLowerCase().includes(q)) return true;
    if ((w.description ?? '').toLowerCase().includes(q)) return true;
    if (w.mcps.some((m) => m.toLowerCase().includes(q))) return true;
    return false;
  });
}

export default function WorkerListPanel({
  workers,
  stats,
  tab,
  onTabChange,
  searchQuery,
  loading = false,
  onChat,
  onViewMore,
}: WorkerListPanelProps) {
  const filtered = useMemo(
    () => applySearch(applyTab(workers, tab), searchQuery),
    [workers, tab, searchQuery],
  );

  const tabs = useMemo(() => ([
    { key: 'all' as const, label: '全部', count: stats.total },
    { key: 'template' as const, label: '模板', count: stats.total },
    { key: 'online' as const, label: '在线', count: stats.online },
  ]), [stats.total, stats.online]);

  const empty = filtered.length === 0;

  return (
    <section className="worker-list-panel" aria-label="数字员工列表">
      <div className="worker-list-panel__toolbar">
        <TabFilter tabs={tabs} activeKey={tab} onChange={(k) => onTabChange(k as WorkerListTab)} />
        <StatsBar stats={stats} />
      </div>

      {loading && workers.length === 0 ? (
        <div className="worker-list-panel__state" role="status">加载中…</div>
      ) : empty ? (
        <div className="worker-list-panel__state" role="status">
          {searchQuery ? '没有匹配的员工' : '暂无员工，点击右上角新建'}
        </div>
      ) : (
        <div className="worker-list-panel__grid" role="list">
          {filtered.map((w) => (
            <div key={w.name} role="listitem" className="worker-list-panel__cell">
              <WorkerCard
                name={w.name}
                role={w.role}
                description={w.description ?? ''}
                avatar={w.avatar}
                status={w.status}
                mcps={w.mcps}
                instanceCount={w.instanceCount}
                teams={w.teams}
                lastActivity={w.lastActivity ? { summary: w.lastActivity.summary, ts: w.lastActivity.at } : null}
                onChat={onChat ? () => onChat(w.name) : undefined}
                onViewMore={onViewMore ? (action) => onViewMore(w.name, action) : undefined}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
