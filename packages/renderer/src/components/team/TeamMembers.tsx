// 团队成员子面板：展开某个团队时展示成员列表 + 添加/移除。
import { useEffect, useState } from 'react';
import {
  apiAddTeamMember,
  apiListTeamMembers,
  apiRemoveTeamMember,
} from '../../api/client';
import type { ApiResult } from '../../api/client';

export interface TeamMemberRow {
  id: string;
  teamId: string;
  instanceId: string;
  roleInTeam: string | null;
  joinedAt: string;
}

export interface InstanceOption {
  id: string;
  memberName: string;
}

interface Props {
  teamId: string;
  instanceOptions: InstanceOption[];
  onResponse: (r: ApiResult) => void;
}

const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 };

export function TeamMembers({ teamId, instanceOptions, onResponse }: Props) {
  const [members, setMembers] = useState<TeamMemberRow[]>([]);
  const [instanceId, setInstanceId] = useState('');
  const [roleInTeam, setRoleInTeam] = useState('');

  const refresh = async (): Promise<void> => {
    const r = await apiListTeamMembers(teamId);
    onResponse(r);
    if (r.ok && Array.isArray(r.data)) setMembers(r.data as TeamMemberRow[]);
  };

  useEffect(() => {
    void refresh();
  }, [teamId]);

  const onAdd = async (): Promise<void> => {
    if (!instanceId) return;
    const r = await apiAddTeamMember(teamId, {
      instanceId,
      roleInTeam: roleInTeam || undefined,
    });
    onResponse(r);
    setInstanceId('');
    setRoleInTeam('');
    await refresh();
  };

  const onRemove = async (iid: string): Promise<void> => {
    const r = await apiRemoveTeamMember(teamId, iid);
    onResponse(r);
    await refresh();
  };

  return (
    <div
      data-testid={`team-members-${teamId}`}
      style={{ marginTop: 8, padding: 8, background: '#fafafa', borderRadius: 4 }}
    >
      <div style={row}>
        <select
          data-testid={`team-add-member-select-${teamId}`}
          value={instanceId}
          onChange={(e) => setInstanceId(e.target.value)}
          style={{ padding: 4, fontSize: 13 }}
        >
          <option value="">-- 选实例加入 --</option>
          {instanceOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.memberName} ({o.id.slice(0, 8)})
            </option>
          ))}
        </select>
        <input
          data-testid={`team-add-member-role-${teamId}`}
          placeholder="roleInTeam（可选）"
          value={roleInTeam}
          onChange={(e) => setRoleInTeam(e.target.value)}
          style={{ padding: 4, fontSize: 13, width: 160 }}
        />
        <button
          data-testid={`team-add-member-submit-${teamId}`}
          onClick={() => void onAdd()}
          disabled={!instanceId}
        >
          加入
        </button>
        <button data-testid={`team-members-refresh-${teamId}`} onClick={() => void refresh()}>
          刷新成员
        </button>
      </div>

      <table
        data-testid={`team-members-list-${teamId}`}
        style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8, fontSize: 12 }}
      >
        <thead>
          <tr style={{ background: '#eee' }}>
            <th style={{ textAlign: 'left', padding: 4 }}>instanceId</th>
            <th style={{ textAlign: 'left', padding: 4 }}>roleInTeam</th>
            <th style={{ textAlign: 'left', padding: 4 }}>joinedAt</th>
            <th style={{ padding: 4 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr
              key={m.id}
              data-testid={`team-member-row-${teamId}-${m.instanceId}`}
              style={{ borderBottom: '1px solid #eee' }}
            >
              <td style={{ padding: 4, fontFamily: 'monospace' }}>{m.instanceId}</td>
              <td style={{ padding: 4 }}>{m.roleInTeam ?? '-'}</td>
              <td style={{ padding: 4 }}>{m.joinedAt}</td>
              <td style={{ padding: 4 }}>
                <button
                  data-testid={`team-remove-member-${teamId}-${m.instanceId}`}
                  onClick={() => void onRemove(m.instanceId)}
                >
                  移除
                </button>
              </td>
            </tr>
          ))}
          {members.length === 0 && (
            <tr>
              <td colSpan={4} style={{ padding: 6, color: '#999' }}>
                暂无成员
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
