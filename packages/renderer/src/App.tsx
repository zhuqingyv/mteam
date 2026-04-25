import { useState, useRef, useEffect } from 'react';
import CapsuleCard from './organisms/CapsuleCard';
import ExpandedView from './organisms/ExpandedView';
import TeamMonitorPanel from './organisms/TeamMonitorPanel';
import { useWindowStore, selectExpanded, selectSetExpanded } from './store';
import { useWsEvents } from './hooks/useWsEvents';

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
  useWsEvents();

  if (WINDOW_TYPE === 'team') {
    return <div className="app"><TeamMonitorPanel teams={DEMO_TEAMS} agents={DEMO_AGENTS} /></div>;
  }

  const expanded = useWindowStore(selectExpanded);
  const setExpanded = useWindowStore(selectSetExpanded);
  const [animating, setAnimating] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (INITIAL_EXPANDED) setExpanded(true);
  }, [setExpanded]);

  const clearTimers = () => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
  };
  const schedule = (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    timersRef.current.push(t);
  };

  const toggle = () => {
    clearTimers();
    const next = !expanded;
    setAnimating(true);
    if (next) {
      window.electronAPI?.resize(EXPANDED.width, EXPANDED.height, 'bottom-right', true);
      requestAnimationFrame(() => setExpanded(true));
      schedule(() => setAnimating(false), ANIM_MS);
    } else {
      setExpanded(false);
      schedule(() => {
        window.electronAPI?.resize(CAPSULE.width, CAPSULE.height, 'bottom-right', true);
      }, ANIM_MS);
      schedule(() => setAnimating(false), ANIM_MS * 2);
    }
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
