import Button from '../../atoms/Button';
import StatusDot from '../../atoms/StatusDot';
import './PrimaryAgentSettings.css';

export interface PrimaryAgentConfig {
  model?: string;
  maxTokens?: number;
}

interface PrimaryAgentSettingsProps {
  config?: PrimaryAgentConfig;
  running?: boolean;
  onStart?: () => void;
  onStop?: () => void;
}

export default function PrimaryAgentSettings({
  config, running = false, onStart, onStop,
}: PrimaryAgentSettingsProps) {
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
        <dt>Model</dt>
        <dd>{config?.model || '—'}</dd>
        <dt>Max Tokens</dt>
        <dd>{config?.maxTokens ?? '—'}</dd>
      </dl>
      <div className="pa-settings__actions">
        <Button variant="primary" size="sm" onClick={onStart} disabled={running}>Start</Button>
        <Button variant="ghost" size="sm" onClick={onStop} disabled={!running}>Stop</Button>
      </div>
    </div>
  );
}
