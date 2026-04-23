// 花名册面板：添加/列表/搜索/详情/更新/别名/删除。
import { useEffect, useState } from 'react';
import { useAtom } from 'jotai';
import { apiGet, apiPost, apiPut, apiDelete } from '../api/client';
import { rosterResponseAtom } from '../store/atoms';
import { ResponseBox } from './ResponseBox';
import { RosterForm, type RosterFormValue } from './roster/RosterForm';

interface RosterEntry {
  instanceId: string;
  memberName: string;
  alias: string;
  scope: 'local' | 'remote';
  status: string;
  address: string;
  teamId: string | null;
  task: string | null;
}

// 把表单值转成后端 payload，空字符串回退成 null
function toPayload(v: RosterFormValue): Record<string, unknown> {
  return {
    instanceId: v.instanceId,
    memberName: v.memberName,
    alias: v.alias || v.memberName,
    scope: v.scope,
    status: v.status,
    address: v.address,
    teamId: v.teamId || null,
    task: v.task || null,
  };
}

export function RosterPanel() {
  const [list, setList] = useState<RosterEntry[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [aliasInputs, setAliasInputs] = useState<Record<string, string>>({});
  const [response, setResponse] = useAtom(rosterResponseAtom);

  const refresh = async (): Promise<void> => {
    const r = await apiGet<RosterEntry[]>('/api/roster');
    setResponse(r);
    if (r.ok && Array.isArray(r.data)) setList(r.data);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onAdd = async (v: RosterFormValue): Promise<void> => {
    const r = await apiPost('/api/roster', toPayload(v));
    setResponse(r);
    await refresh();
  };

  const onSearch = async (): Promise<void> => {
    if (!searchQ) return;
    const r = await apiGet<RosterEntry[]>(
      `/api/roster/search?q=${encodeURIComponent(searchQ)}`,
    );
    setResponse(r);
  };

  const onGet = async (id: string): Promise<void> => {
    const r = await apiGet(`/api/roster/${encodeURIComponent(id)}`);
    setResponse(r);
  };

  const onUpdateStatus = async (id: string): Promise<void> => {
    // 演示用：把 status toggle 成 offline / online
    const entry = list.find((e) => e.instanceId === id);
    const next = entry?.status === 'online' ? 'offline' : 'online';
    const r = await apiPut(`/api/roster/${encodeURIComponent(id)}`, { status: next });
    setResponse(r);
    await refresh();
  };

  const onSetAlias = async (id: string): Promise<void> => {
    const alias = aliasInputs[id] ?? '';
    const r = await apiPut(`/api/roster/${encodeURIComponent(id)}/alias`, { alias });
    setResponse(r);
    await refresh();
  };

  const onDelete = async (id: string): Promise<void> => {
    const r = await apiDelete(`/api/roster/${encodeURIComponent(id)}`);
    setResponse(r);
    await refresh();
  };

  return (
    <section>
      <RosterForm onSubmit={onAdd} />

      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <input
          data-testid="roster-search-input"
          placeholder="按 alias/memberName 搜索"
          style={{ flex: 1, padding: 4 }}
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
        />
        <button data-testid="roster-search-submit" onClick={() => void onSearch()}>
          搜索
        </button>
        <button data-testid="roster-refresh" onClick={() => void refresh()}>
          刷新列表
        </button>
      </div>

      <table
        data-testid="roster-list"
        style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 13 }}
      >
        <thead>
          <tr style={{ background: '#eee' }}>
            <th style={{ textAlign: 'left', padding: 6 }}>instanceId</th>
            <th style={{ textAlign: 'left', padding: 6 }}>member / alias</th>
            <th style={{ textAlign: 'left', padding: 6 }}>scope</th>
            <th style={{ textAlign: 'left', padding: 6 }}>status</th>
            <th style={{ padding: 6 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {list.map((e) => (
            <tr
              key={e.instanceId}
              data-testid={`roster-row-${e.instanceId}`}
              style={{ borderBottom: '1px solid #eee' }}
            >
              <td style={{ padding: 6, fontFamily: 'monospace', fontSize: 12 }}>{e.instanceId}</td>
              <td style={{ padding: 6 }}>
                {e.memberName} / {e.alias}
              </td>
              <td style={{ padding: 6 }}>{e.scope}</td>
              <td style={{ padding: 6 }}>{e.status}</td>
              <td style={{ padding: 6 }}>
                <button data-testid={`roster-get-${e.instanceId}`} onClick={() => void onGet(e.instanceId)}>
                  详情
                </button>{' '}
                <button
                  data-testid={`roster-toggle-status-${e.instanceId}`}
                  onClick={() => void onUpdateStatus(e.instanceId)}
                >
                  切换状态
                </button>{' '}
                <input
                  data-testid={`roster-alias-input-${e.instanceId}`}
                  placeholder="新 alias"
                  style={{ width: 80 }}
                  value={aliasInputs[e.instanceId] ?? ''}
                  onChange={(ev) =>
                    setAliasInputs((prev) => ({ ...prev, [e.instanceId]: ev.target.value }))
                  }
                />{' '}
                <button
                  data-testid={`roster-set-alias-${e.instanceId}`}
                  onClick={() => void onSetAlias(e.instanceId)}
                >
                  设别名
                </button>{' '}
                <button data-testid={`roster-delete-${e.instanceId}`} onClick={() => void onDelete(e.instanceId)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ResponseBox testId="roster-response" result={response} />
    </section>
  );
}
