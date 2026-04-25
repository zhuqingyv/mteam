import { useRef, useState } from 'react';
import StatusDot from '../../atoms/StatusDot';
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
  const ref = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);

  const down = (e: React.MouseEvent) => {
    e.preventDefault();
    ref.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y };
    setDrag(true);
    const move = (ev: MouseEvent) => {
      const s = ref.current; if (!s) return;
      setPos({ x: s.px + ev.clientX - s.mx, y: s.py + ev.clientY - s.my });
    };
    const up = (ev: MouseEvent) => {
      const s = ref.current;
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      setDrag(false);
      if (s) onDragEnd?.(s.px + ev.clientX - s.mx, s.py + ev.clientY - s.my);
      ref.current = null;
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  return (
    <div className={`agent-card${drag ? ' agent-card--drag' : ''}`} style={{ left: pos.x, top: pos.y }} onMouseDown={down}>
      <div className="agent-card__head">
        <StatusDot status={DOT[status]} size="sm" />
        <span className="agent-card__name">{name}</span>
      </div>
      {lastMessage && <div className="agent-card__msg">{lastMessage}</div>}
    </div>
  );
}
