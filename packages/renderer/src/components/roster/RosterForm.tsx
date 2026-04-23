// Roster 新增条目的表单，字段对齐 handleAddRoster。
import { useState } from 'react';

export interface RosterFormValue {
  instanceId: string;
  memberName: string;
  alias: string;
  scope: 'local' | 'remote';
  status: string;
  address: string;
  teamId: string;
  task: string;
}

interface Props {
  onSubmit: (v: RosterFormValue) => void;
}

const row: React.CSSProperties = { display: 'flex', gap: 8, marginBottom: 6 };
const label: React.CSSProperties = { width: 110, fontSize: 13 };
const input: React.CSSProperties = { flex: 1, padding: 4, fontSize: 13 };

export function RosterForm({ onSubmit }: Props) {
  const [instanceId, setInstanceId] = useState('');
  const [memberName, setMemberName] = useState('');
  const [alias, setAlias] = useState('');
  const [scope, setScope] = useState<'local' | 'remote'>('local');
  const [status, setStatus] = useState('online');
  const [address, setAddress] = useState('');
  const [teamId, setTeamId] = useState('');
  const [task, setTask] = useState('');

  return (
    <div
      data-testid="roster-create-form"
      style={{ border: '1px solid #ccc', padding: 12, borderRadius: 4 }}
    >
      <h3 style={{ margin: '0 0 8px' }}>添加 roster 条目</h3>
      <div style={row}>
        <label style={label}>instanceId</label>
        <input
          data-testid="roster-create-instance-id"
          style={input}
          value={instanceId}
          onChange={(e) => setInstanceId(e.target.value)}
        />
      </div>
      <div style={row}>
        <label style={label}>memberName</label>
        <input
          data-testid="roster-create-member"
          style={input}
          value={memberName}
          onChange={(e) => setMemberName(e.target.value)}
        />
      </div>
      <div style={row}>
        <label style={label}>alias</label>
        <input
          data-testid="roster-create-alias"
          style={input}
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
        />
      </div>
      <div style={row}>
        <label style={label}>scope</label>
        <select
          data-testid="roster-create-scope"
          style={input}
          value={scope}
          onChange={(e) => setScope(e.target.value as 'local' | 'remote')}
        >
          <option value="local">local</option>
          <option value="remote">remote</option>
        </select>
      </div>
      <div style={row}>
        <label style={label}>status</label>
        <input
          data-testid="roster-create-status"
          style={input}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        />
      </div>
      <div style={row}>
        <label style={label}>address</label>
        <input
          data-testid="roster-create-address"
          style={input}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </div>
      <div style={row}>
        <label style={label}>teamId</label>
        <input
          data-testid="roster-create-team-id"
          style={input}
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
        />
      </div>
      <div style={row}>
        <label style={label}>task</label>
        <input
          data-testid="roster-create-task"
          style={input}
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />
      </div>
      <button
        data-testid="roster-create-submit"
        onClick={() => onSubmit({ instanceId, memberName, alias, scope, status, address, teamId, task })}
      >
        添加
      </button>
    </div>
  );
}
