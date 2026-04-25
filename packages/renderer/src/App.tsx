import { useState, useRef } from 'react';
import CapsuleCard from './organisms/CapsuleCard';
import ExpandedView from './organisms/ExpandedView';

const CAPSULE = { width: 380, height: 120 };
const EXPANDED = { width: 640, height: 620 };
const ANIM_MS = 350;

const INITIAL_EXPANDED = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('expanded') === '1';

export default function App() {
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
