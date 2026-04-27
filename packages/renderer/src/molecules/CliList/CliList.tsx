import AgentLogo from '../../atoms/AgentLogo';
import Button from '../../atoms/Button';
import StatusDot from '../../atoms/StatusDot';
import './CliList.css';

export interface CliEntry {
  name: string;
  path: string;
  available: boolean;
}

interface CliListProps {
  clis: CliEntry[];
  onRefresh?: () => void;
}

export default function CliList({ clis, onRefresh }: CliListProps) {
  return (
    <div className="cli-list">
      <div className="cli-list__head">
        <span className="cli-list__title">Detected CLIs</span>
        <Button variant="ghost" size="sm" onClick={onRefresh}>Refresh</Button>
      </div>
      {clis.length === 0 ? (
        <div className="cli-list__empty">
          <div className="cli-list__empty-title">未检测到任何 CLI</div>
          <div className="cli-list__empty-hint">
            安装 <code>claude</code> / <code>codex</code> / <code>gemini</code> 后点右上角 Refresh
          </div>
        </div>
      ) : (
        <ul className="cli-list__items">
          {clis.map((c) => (
            <li key={c.name} className="cli-list__item">
              <AgentLogo cliType={c.name} size={18} grayscale={!c.available} />
              <StatusDot status={c.available ? 'online' : 'offline'} size="sm" />
              <span className="cli-list__name">{c.name}</span>
              <span className="cli-list__path" title={c.path}>{c.path || '—'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
