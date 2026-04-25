import { useState, useRef } from 'react';
import CapsuleCard from './organisms/CapsuleCard';
import ExpandedView from './organisms/ExpandedView';
import TeamMonitorPanel from './organisms/TeamMonitorPanel';

const CAPSULE = { width: 380, height: 120 };
const EXPANDED = { width: 640, height: 620 };
const ANIM_MS = 350;

const search = typeof window !== 'undefined' ? window.location.search : '';
const WINDOW_TYPE = new URLSearchParams(search).get('window');
const INITIAL_EXPANDED = new URLSearchParams(search).get('expanded') === '1';

const DEMO_TEAMS = [
  { id: 't1', name: 'MTEAM', memberCount: 4 },
  { id: 't2', name: 'Frontend', memberCount: 2 },
];
const DEMO_AGENTS = [
  { id: 'claude', name: 'Claude', status: 'idle', x: 120, y: 120 },
  { id: 'codex', name: 'Codex', status: 'running', x: 320, y: 180 },
  { id: 'qwen', name: 'Qwen', status: 'idle', x: 520, y: 140 },
];

export default function App() {
  if (WINDOW_TYPE === 'team') {
    return <div className="app"><TeamMonitorPanel teams={DEMO_TEAMS} agents={DEMO_AGENTS} /></div>;
  }

  const [expanded, setExpanded] = useState(INITIAL_EXPANDED);
  const [animating, setAnimating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggle = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const next = !expanded;
    setExpanded(next);
    setAnimating(true);
    const target = next ? EXPANDED : CAPSULE;
    window.electronAPI?.resize(target.width, target.height, 'bottom-right', true);
    timerRef.current = setTimeout(() => setAnimating(false), ANIM_MS);
  };

  return (
    <div className="app">
      <CapsuleCard name="MTEAM" agentCount={4} taskCount={2} messageCount={3} online
        expanded={expanded} animating={animating} onToggle={toggle}>
        {expanded && <ExpandedView />}
      </CapsuleCard>
    </div>
  );
}
