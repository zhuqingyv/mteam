// 创建团队表单：name + leaderInstanceId 下拉。
import { useState } from 'react';

export interface LeaderOption {
  id: string;
  memberName: string;
  status: string;
}

interface Props {
  leaderOptions: LeaderOption[];
  onSubmit: (v: { name: string; leaderInstanceId: string }) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const row: React.CSSProperties = { display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' };
const label: React.CSSProperties = { width: 110, fontSize: 13 };
const input: React.CSSProperties = { flex: 1, padding: 4, fontSize: 13 };

export function TeamCreateForm({ leaderOptions, onSubmit, onRefresh }: Props) {
  const [name, setName] = useState('');
  const [leaderInstanceId, setLeaderInstanceId] = useState('');

  const handleSubmit = async (): Promise<void> => {
    if (!name || !leaderInstanceId) return;
    await onSubmit({ name, leaderInstanceId });
    setName('');
    setLeaderInstanceId('');
  };

  return (
    <div
      data-testid="team-create-form"
      style={{ border: '1px solid #ccc', padding: 12, borderRadius: 4 }}
    >
      <h3 style={{ margin: '0 0 8px' }}>创建团队</h3>
      <div style={row}>
        <label style={label}>name</label>
        <input
          data-testid="team-create-name"
          style={input}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div style={row}>
        <label style={label}>leaderInstanceId</label>
        <select
          data-testid="team-create-leader"
          value={leaderInstanceId}
          onChange={(e) => setLeaderInstanceId(e.target.value)}
          style={{ ...input, padding: 4 }}
        >
          <option value="">-- 选一个 leader 实例 --</option>
          {leaderOptions.map((i) => (
            <option key={i.id} value={i.id}>
              {i.memberName} ({i.id.slice(0, 8)}) [{i.status}]
            </option>
          ))}
        </select>
      </div>
      <button
        data-testid="team-create-submit"
        onClick={() => void handleSubmit()}
        disabled={!name || !leaderInstanceId}
      >
        创建团队
      </button>
      <button
        data-testid="team-refresh"
        style={{ marginLeft: 8 }}
        onClick={() => void onRefresh()}
      >
        刷新
      </button>
    </div>
  );
}
