// 角色实例面板：创建/列表/激活/请求下线/删除。
import { useEffect, useState } from 'react';
import { useAtom } from 'jotai';
import { apiGet, apiPost, apiDelete } from '../api/client';
import { instanceResponseAtom } from '../store/atoms';
import { ResponseBox } from './ResponseBox';

interface Instance {
  id: string;
  templateName: string;
  memberName: string;
  isLeader: boolean;
  leaderName: string | null;
  task: string | null;
  status: string;
}

const row: React.CSSProperties = { display: 'flex', gap: 8, marginBottom: 6 };
const label: React.CSSProperties = { width: 110, fontSize: 13 };
const input: React.CSSProperties = { flex: 1, padding: 4, fontSize: 13 };

// 状态徽章颜色映射：PENDING 黄、ACTIVE 绿、PENDING_OFFLINE 橙，其他落灰色。
function getStatusBadgeStyle(status: string): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 500,
  };
  switch (status) {
    case 'PENDING':
      return { ...base, background: '#fef3c7', color: '#92400e' };
    case 'ACTIVE':
      return { ...base, background: '#d1fae5', color: '#065f46' };
    case 'PENDING_OFFLINE':
      return { ...base, background: '#fed7aa', color: '#9a3412' };
    default:
      return { ...base, background: '#e5e7eb', color: '#374151' };
  }
}

export function InstancePanel() {
  const [list, setList] = useState<Instance[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [memberName, setMemberName] = useState('');
  const [isLeader, setIsLeader] = useState(false);
  const [task, setTask] = useState('');
  const [leaderName, setLeaderName] = useState('');
  // 请求下线时 caller（leader）的 instance id，需在 UI 上给出入口
  const [callerId, setCallerId] = useState('');
  const [response, setResponse] = useAtom(instanceResponseAtom);

  const refresh = async (): Promise<void> => {
    const r = await apiGet<Instance[]>('/api/role-instances');
    setResponse(r);
    if (r.ok && Array.isArray(r.data)) setList(r.data);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onCreate = async (): Promise<void> => {
    const payload = {
      templateName,
      memberName,
      isLeader,
      task: task || null,
      leaderName: leaderName || null,
    };
    const r = await apiPost('/api/role-instances', payload);
    setResponse(r);
    await refresh();
  };

  const onActivate = async (id: string): Promise<void> => {
    const r = await apiPost(`/api/role-instances/${encodeURIComponent(id)}/activate`);
    setResponse(r);
    await refresh();
  };

  // 请求下线：优先用 header X-Role-Instance-Id（任务要求），body 保留作为兼容 fallback。
  // callerId 为空时 fallback 到列表里第一个 leader 实例，方便手工测试。
  const onRequestOffline = async (id: string): Promise<void> => {
    const effectiveCaller =
      callerId.trim() || list.find((x) => x.isLeader && x.status === 'ACTIVE')?.id || '';
    const r = await apiPost(
      `/api/role-instances/${encodeURIComponent(id)}/request-offline`,
      { callerInstanceId: effectiveCaller },
      { 'X-Role-Instance-Id': effectiveCaller },
    );
    setResponse(r);
    await refresh();
  };

  const onDelete = async (id: string, force: boolean): Promise<void> => {
    const q = force ? '?force=1' : '';
    const r = await apiDelete(`/api/role-instances/${encodeURIComponent(id)}${q}`);
    setResponse(r);
    await refresh();
  };

  return (
    <section>
      <div
        data-testid="instance-create-form"
        style={{ border: '1px solid #ccc', padding: 12, borderRadius: 4 }}
      >
        <h3 style={{ margin: '0 0 8px' }}>创建实例</h3>
        <div style={row}>
          <label style={label}>templateName</label>
          <input
            data-testid="instance-create-template"
            style={input}
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
          />
        </div>
        <div style={row}>
          <label style={label}>memberName</label>
          <input
            data-testid="instance-create-member"
            style={input}
            value={memberName}
            onChange={(e) => setMemberName(e.target.value)}
          />
        </div>
        <div style={row}>
          <label style={label}>isLeader</label>
          <input
            data-testid="instance-create-isleader"
            type="checkbox"
            checked={isLeader}
            onChange={(e) => setIsLeader(e.target.checked)}
          />
        </div>
        <div style={row}>
          <label style={label}>task</label>
          <input
            data-testid="instance-create-task"
            style={input}
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
        </div>
        <div style={row}>
          <label style={label}>leaderName</label>
          <input
            data-testid="instance-create-leader"
            style={input}
            value={leaderName}
            onChange={(e) => setLeaderName(e.target.value)}
          />
        </div>
        <button data-testid="instance-create-submit" onClick={() => void onCreate()}>
          创建
        </button>
      </div>

      <div style={{ ...row, marginTop: 12 }}>
        <label style={label}>callerInstanceId</label>
        <input
          data-testid="instance-caller-id"
          style={input}
          placeholder="请求下线时作为 leader 身份"
          value={callerId}
          onChange={(e) => setCallerId(e.target.value)}
        />
      </div>

      <table
        data-testid="instance-list"
        style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 13 }}
      >
        <thead>
          <tr style={{ background: '#eee' }}>
            <th style={{ textAlign: 'left', padding: 6 }}>id</th>
            <th style={{ textAlign: 'left', padding: 6 }}>member</th>
            <th style={{ textAlign: 'left', padding: 6 }}>status</th>
            <th style={{ textAlign: 'left', padding: 6 }}>leader</th>
            <th style={{ padding: 6 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {list.map((i) => (
            <tr
              key={i.id}
              data-testid={`instance-row-${i.id}`}
              style={{ borderBottom: '1px solid #eee' }}
            >
              <td style={{ padding: 6, fontFamily: 'monospace', fontSize: 12 }}>{i.id}</td>
              <td style={{ padding: 6 }}>{i.memberName}</td>
              <td style={{ padding: 6 }}>
                {/* 状态徽章：按状态使用不同颜色，便于快速识别生命周期阶段 */}
                <span data-testid={`instance-status-${i.id}`} style={getStatusBadgeStyle(i.status)}>
                  {i.status}
                </span>
              </td>
              <td style={{ padding: 6 }}>{i.isLeader ? 'yes' : 'no'}</td>
              <td style={{ padding: 6 }}>
                {/* 激活按钮：仅 PENDING 状态可见 */}
                {i.status === 'PENDING' && (
                  <button
                    data-testid={`instance-activate-${i.id}`}
                    onClick={() => void onActivate(i.id)}
                  >
                    激活
                  </button>
                )}{' '}
                {/* 请求下线按钮：仅 ACTIVE 状态可见 */}
                {i.status === 'ACTIVE' && (
                  <button
                    data-testid={`instance-request-offline-${i.id}`}
                    onClick={() => void onRequestOffline(i.id)}
                  >
                    请求下线
                  </button>
                )}{' '}
                <button data-testid={`instance-delete-${i.id}`} onClick={() => void onDelete(i.id, false)}>
                  删除
                </button>{' '}
                <button
                  data-testid={`instance-force-delete-${i.id}`}
                  onClick={() => void onDelete(i.id, true)}
                >
                  强删
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ResponseBox testId="instance-response" result={response} />
    </section>
  );
}
