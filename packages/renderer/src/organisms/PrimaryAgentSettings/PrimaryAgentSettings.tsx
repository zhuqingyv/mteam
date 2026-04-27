import StatusDot from '../../atoms/StatusDot';
import type { PrimaryAgentRow } from '../../api/primaryAgent';
import './PrimaryAgentSettings.css';

interface PrimaryAgentSettingsProps {
  config: PrimaryAgentRow | null;
  running: boolean;
}

export default function PrimaryAgentSettings({ config, running }: PrimaryAgentSettingsProps) {
  return (
    <div className="pa-settings">
      <div className="pa-settings__head">
        <div className="pa-settings__title">
          <span>Primary Agent</span>
          <StatusDot status={running ? 'online' : 'offline'} size="sm" />
        </div>
        <span className="pa-settings__state">{running ? 'Running' : 'Stopped'}</span>
      </div>
      <dl className="pa-settings__grid">
        <dt>Name</dt>
        <dd>{config?.name ?? '—'}</dd>
        <dt>CLI</dt>
        <dd>{config?.cliType ?? '—'}</dd>
      </dl>
    </div>
  );
}
