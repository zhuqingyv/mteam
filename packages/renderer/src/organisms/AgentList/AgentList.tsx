import StatusDot from '../../atoms/StatusDot';
import Button from '../../atoms/Button';
import './AgentList.css';

export type AgentStatus = 'idle' | 'running' | 'offline';
const DOT: Record<AgentStatus, 'online' | 'busy' | 'offline'> = {
  idle: 'online', running: 'busy', offline: 'offline',
};

export interface AgentListItem {
  id: string;
  name: string;
  status: AgentStatus;
  task?: string;
}

interface AgentListProps {
  agents: AgentListItem[];
  onActivate?: (id: string) => void;
  onRequestOffline?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export default function AgentList({ agents, onActivate, onRequestOffline, onDelete }: AgentListProps) {
  if (agents.length === 0) {
    return <div className="agent-list agent-list--empty">No agents</div>;
  }
  return (
    <ul className="agent-list">
      {agents.map((a) => (
        <li key={a.id} className="agent-list__item">
          <StatusDot status={DOT[a.status]} size="sm" />
          <div className="agent-list__meta">
            <span className="agent-list__name">{a.name}</span>
            {a.task && <span className="agent-list__task" title={a.task}>{a.task}</span>}
          </div>
          <div className="agent-list__ops">
            {a.status === 'offline' && onActivate && (
              <Button variant="primary" size="sm" onClick={() => onActivate(a.id)}>Activate</Button>
            )}
            {a.status !== 'offline' && onRequestOffline && (
              <Button variant="ghost" size="sm" onClick={() => onRequestOffline(a.id)}>Offline</Button>
            )}
            {onDelete && (
              <Button variant="ghost" size="sm" onClick={() => onDelete(a.id)}>Delete</Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
