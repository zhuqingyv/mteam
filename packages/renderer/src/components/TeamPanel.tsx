// 团队面板：创建/列表/展开成员/解散。
import { Fragment, useEffect, useState } from 'react';
import { useAtom } from 'jotai';
import {
  apiCreateTeam,
  apiDisbandTeam,
  apiGet,
  apiListTeams,
} from '../api/client';
import { teamResponseAtom } from '../store/atoms';
import { ResponseBox } from './ResponseBox';
import { TeamCreateForm } from './team/TeamCreateForm';
import { TeamMembers, type InstanceOption } from './team/TeamMembers';

interface TeamRow {
  id: string;
  name: string;
  leaderInstanceId: string;
  description: string | null;
  status: string;
  createdAt: string;
  disbandedAt: string | null;
}

interface Instance {
  id: string;
  memberName: string;
  isLeader: boolean;
  status: string;
}

function getStatusBadgeStyle(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 500,
  };
  if (status === 'ACTIVE') return { ...base, background: '#d1fae5', color: '#065f46' };
  if (status === 'DISBANDED') return { ...base, background: '#fee2e2', color: '#991b1b' };
  return { ...base, background: '#e5e7eb', color: '#374151' };
}

export function TeamPanel() {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [response, setResponse] = useAtom(teamResponseAtom);

  // 一次刷新：拉 team 列表 + 实例列表 + 并行统计每队成员数
  const refresh = async (): Promise<void> => {
    const [tRes, iRes] = await Promise.all([
      apiListTeams(),
      apiGet<Instance[]>('/api/role-instances'),
    ]);
    setResponse(tRes);
    const list = tRes.ok && Array.isArray(tRes.data) ? (tRes.data as TeamRow[]) : [];
    setTeams(list);
    if (iRes.ok && Array.isArray(iRes.data)) setInstances(iRes.data as Instance[]);

    // 成员数只对 ACTIVE 团队拉，DISBANDED 不展示成员
    const counts: Record<string, number> = {};
    const active = list.filter((t) => t.status === 'ACTIVE');
    await Promise.all(
      active.map(async (t) => {
        const r = await apiGet(`/api/teams/${encodeURIComponent(t.id)}/members`);
        counts[t.id] = r.ok && Array.isArray(r.data) ? r.data.length : 0;
      }),
    );
    setMemberCounts(counts);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onCreate = async (v: { name: string; leaderInstanceId: string }): Promise<void> => {
    const r = await apiCreateTeam(v);
    setResponse(r);
    await refresh();
  };

  const onDisband = async (id: string): Promise<void> => {
    const r = await apiDisbandTeam(id);
    setResponse(r);
    if (expandedId === id) setExpandedId(null);
    await refresh();
  };

  const onToggleExpand = (id: string): void => {
    setExpandedId((curr) => (curr === id ? null : id));
  };

  const instanceOptions: InstanceOption[] = instances.map((i) => ({
    id: i.id,
    memberName: i.memberName,
  }));
  const leaderOptions = instances.filter((i) => i.isLeader);

  return (
    <section>
      <TeamCreateForm
        leaderOptions={leaderOptions}
        onSubmit={onCreate}
        onRefresh={refresh}
      />

      <table
        data-testid="team-list"
        style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 13 }}
      >
        <thead>
          <tr style={{ background: '#eee' }}>
            <th style={{ textAlign: 'left', padding: 6 }}>name</th>
            <th style={{ textAlign: 'left', padding: 6 }}>leader</th>
            <th style={{ textAlign: 'left', padding: 6 }}>status</th>
            <th style={{ textAlign: 'left', padding: 6 }}>members</th>
            <th style={{ padding: 6 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((t) => (
            <Fragment key={t.id}>
              <tr
                data-testid={`team-row-${t.id}`}
                style={{ borderBottom: '1px solid #eee' }}
              >
                <td style={{ padding: 6 }} data-testid={`team-name-${t.id}`}>
                  {t.name}
                </td>
                <td style={{ padding: 6, fontFamily: 'monospace', fontSize: 12 }}>
                  {t.leaderInstanceId}
                </td>
                <td style={{ padding: 6 }}>
                  <span data-testid={`team-status-${t.id}`} style={getStatusBadgeStyle(t.status)}>
                    {t.status}
                  </span>
                </td>
                <td style={{ padding: 6 }} data-testid={`team-member-count-${t.id}`}>
                  {t.status === 'ACTIVE' ? (memberCounts[t.id] ?? '-') : '-'}
                </td>
                <td style={{ padding: 6 }}>
                  {t.status === 'ACTIVE' && (
                    <>
                      <button
                        data-testid={`team-expand-${t.id}`}
                        onClick={() => onToggleExpand(t.id)}
                      >
                        {expandedId === t.id ? '收起' : '展开'}
                      </button>{' '}
                      <button
                        data-testid={`team-disband-${t.id}`}
                        onClick={() => void onDisband(t.id)}
                      >
                        解散
                      </button>
                    </>
                  )}
                </td>
              </tr>
              {expandedId === t.id && t.status === 'ACTIVE' && (
                <tr>
                  <td colSpan={5} style={{ padding: 0 }}>
                    <TeamMembers
                      teamId={t.id}
                      instanceOptions={instanceOptions}
                      onResponse={setResponse}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {teams.length === 0 && (
            <tr>
              <td colSpan={5} style={{ padding: 8, color: '#999' }}>
                暂无团队
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <ResponseBox testId="team-response" result={response} />
    </section>
  );
}
