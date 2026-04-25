import { useRef, useState } from 'react';
import StatusDot from '../../atoms/StatusDot';
import CapsuleCard from '../../organisms/CapsuleCard';
import './AgentCard.css';

type AgentStatus = 'working' | 'idle' | 'shutdown';
interface AgentCardProps {
  name: string;
  status: AgentStatus;
  lastMessage?: string;
  x?: number; y?: number;
  onDragEnd?: (x: number, y: number) => void;
}
const DOT: Record<AgentStatus, 'online' | 'busy' | 'offline'> = {
  working: 'busy', idle: 'online', shutdown: 'offline',
};

export default function AgentCard({ name, status, lastMessage, x = 0, y = 0, onDragEnd }: AgentCardProps) {
  const [pos, setPos] = useState({ x, y });
  const [drag, setDrag] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<{ mx: number; my: number; px: number; py: number; moved: boolean } | null>(null);

  const down = (e: React.MouseEvent) => {
    e.preventDefault();
    ref.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y, moved: false };
    const move = (ev: MouseEvent) => {
      const s = ref.current; if (!s) return;
      const dx = ev.clientX - s.mx, dy = ev.clientY - s.my;
      if (!s.moved && Math.hypot(dx, dy) > 3) { s.moved = true; setDrag(true); }
      if (s.moved) setPos({ x: s.px + dx, y: s.py + dy });
    };
    const up = (ev: MouseEvent) => {
      const s = ref.current;
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      if (s?.moved) { setDrag(false); onDragEnd?.(s.px + ev.clientX - s.mx, s.py + ev.clientY - s.my); }
      else setExpanded(true);
      ref.current = null;
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  const cls = ['agent-card'];
  if (drag) cls.push('agent-card--drag');
  if (expanded) cls.push('agent-card--expanded');

  return (
    <div className={cls.join(' ')} style={{ left: pos.x, top: pos.y }}>
      {expanded ? (
        <CapsuleCard name={name} agentCount={0} taskCount={0} messageCount={0}
          online={status !== 'shutdown'} expanded onToggle={() => setExpanded(false)} />
      ) : (
        <div className="agent-card__capsule" onMouseDown={down}>
          <div className="agent-card__head">
            <StatusDot status={DOT[status]} size="sm" />
            <span className="agent-card__name">{name}</span>
          </div>
          {lastMessage && <div className="agent-card__msg">{lastMessage}</div>}
        </div>
      )}
    </div>
  );
}
