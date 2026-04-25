import PanelWindow from '../templates/PanelWindow';
import TeamMonitorPanel from '../organisms/TeamMonitorPanel';

const DEMO_TEAMS = [
  { id: 't1', name: 'MTEAM', memberCount: 4 },
  { id: 't2', name: 'Frontend', memberCount: 2 },
];
const DEMO_AGENTS = [
  { id: 'claude', name: 'Claude', status: 'idle', x: 120, y: 120 },
  { id: 'codex', name: 'Codex', status: 'running', x: 320, y: 180 },
  { id: 'qwen', name: 'Qwen', status: 'idle', x: 520, y: 140 },
];

export default function TeamPage() {
  return (
    <PanelWindow>
      <TeamMonitorPanel teams={DEMO_TEAMS} agents={DEMO_AGENTS} />
    </PanelWindow>
  );
}
