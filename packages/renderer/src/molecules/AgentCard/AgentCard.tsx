import { useEffect, useRef, useState } from 'react';
import AgentLogo from '../../atoms/AgentLogo';
import StatusDot from '../../atoms/StatusDot';
import CapsuleCard from '../../organisms/CapsuleCard';
import './AgentCard.css';

type AgentStatus = 'idle' | 'thinking' | 'responding' | 'offline';
interface AgentCardProps {
  name: string;
  status: AgentStatus;
  cliType?: string;
  lastMessage?: string;
  x?: number; y?: number;
  onDragEnd?: (x: number, y: number) => void;
  onPositionChange?: (x: number, y: number) => void;
  getZoom?: () => number;
  elementRef?: (el: HTMLDivElement | null) => void;
}
const DOT: Record<AgentStatus, 'online' | 'thinking' | 'responding' | 'offline'> = {
  idle: 'online', thinking: 'thinking', responding: 'responding', offline: 'offline',
};

export default function AgentCard({
  name, status, cliType, lastMessage, x = 0, y = 0,
  onDragEnd, onPositionChange, getZoom, elementRef,
}: AgentCardProps) {
  const [pos, setPos] = useState({ x, y });
  const [drag, setDrag] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<{ mx: number; my: number; px: number; py: number; moved: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { onPositionChange?.(pos.x, pos.y); }, [pos.x, pos.y, onPositionChange]);

  const down = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ref.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y, moved: false };
    const scale = () => (getZoom ? getZoom() : 1) || 1;
    const move = (ev: MouseEvent) => {
      const s = ref.current; if (!s) return;
      const z = scale();
      const dx = (ev.clientX - s.mx) / z, dy = (ev.clientY - s.my) / z;
      if (!s.moved && Math.hypot(dx, dy) > 3) { s.moved = true; setDrag(true); }
      if (s.moved) setPos({ x: s.px + dx, y: s.py + dy });
    };
    const up = (ev: MouseEvent) => {
      const s = ref.current;
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      if (s?.moved) {
        const z = scale();
        setDrag(false);
        onDragEnd?.(s.px + (ev.clientX - s.mx) / z, s.py + (ev.clientY - s.my) / z);
      }
      else setExpanded(true);
      ref.current = null;
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  const cls = ['agent-card'];
  if (drag) cls.push('agent-card--drag');
  if (expanded) cls.push('agent-card--expanded');

  const setRoot = (el: HTMLDivElement | null) => {
    rootRef.current = el;
    elementRef?.(el);
  };

  return (
    <div ref={setRoot} className={cls.join(' ')} data-status={status} style={{ left: pos.x, top: pos.y }}>
      {expanded ? (
        <CapsuleCard name={name} agentCount={0} taskCount={0} messageCount={0}
          online={status !== 'offline'} expanded onToggle={() => setExpanded(false)} />
      ) : (
        <div className="agent-card__capsule" onMouseDown={down}>
          <div className="agent-card__head">
            {cliType && <AgentLogo cliType={cliType} size={16} grayscale={status === 'offline'} />}
            <StatusDot status={DOT[status]} size="sm" />
            <span className="agent-card__name">{name}</span>
          </div>
          {lastMessage && <div className="agent-card__msg">{lastMessage}</div>}
        </div>
      )}
    </div>
  );
}
