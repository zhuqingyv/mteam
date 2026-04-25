import { useState, useRef } from 'react';
import CapsuleCard from './organisms/CapsuleCard';
import ExpandedView from './organisms/ExpandedView';

const CAPSULE = { width: 380, height: 120 };
const EXPANDED = { width: 640, height: 620 };
const ANIM_MS = 350;

export default function App() {
  const [expanded, setExpanded] = useState(false);
  const [animating, setAnimating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggle = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!expanded) {
      window.electronAPI?.resize(EXPANDED.width, EXPANDED.height, 'bottom-right');
      requestAnimationFrame(() => {
        setExpanded(true);
        setAnimating(true);
        timerRef.current = setTimeout(() => setAnimating(false), ANIM_MS);
      });
    } else {
      setExpanded(false);
      setAnimating(true);
      timerRef.current = setTimeout(() => {
        window.electronAPI?.resize(CAPSULE.width, CAPSULE.height, 'bottom-right');
        setAnimating(false);
      }, ANIM_MS);
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
