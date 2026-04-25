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
        <div className="cli-list__empty">No CLI detected</div>
      ) : (
        <ul className="cli-list__items">
          {clis.map((c) => (
            <li key={c.name} className="cli-list__item">
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
