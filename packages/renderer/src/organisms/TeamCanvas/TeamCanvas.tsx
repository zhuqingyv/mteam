import { useCallback, useEffect, useRef } from 'react';
import AgentCard from '../../molecules/AgentCard';
import { useCanvasTransform, type Transform } from '../../hooks/useCanvasTransform';
import { useTentacles } from '../../hooks/useTentacles';
import './TeamCanvas.css';

interface Agent {
  id: string;
  name: string;
  status: string;
  cliType?: string;
  lastMessage?: string;
  x: number;
  y: number;
  isLeader?: boolean;
}

interface TeamCanvasProps {
  agents: Agent[];
  initialTransform?: Transform;
  onAgentDragEnd?: (id: string, x: number, y: number) => void;
  onTransformCommit?: (t: Transform) => void;
}

export default function TeamCanvas({
  agents, initialTransform, onAgentDragEnd, onTransformCommit,
}: TeamCanvasProps) {
  const { viewportRef, containerRef, onPanStart, reset, isPanning, getZoom, setTransform } =
    useCanvasTransform({ onTransformCommit });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cardEls = useRef<Map<string, HTMLElement>>(new Map());

  const getCardElement = useCallback((id: string) => cardEls.current.get(id) ?? null, []);

  useTentacles(
    canvasRef,
    agents.map((a) => ({ id: a.id, isLeader: !!a.isLeader })),
    getCardElement,
  );

  useEffect(() => {
    if (initialTransform) setTransform(initialTransform);
  }, [initialTransform, setTransform]);

  const cls = ['team-canvas'];
  if (isPanning) cls.push('team-canvas--panning');

  return (
    <div
      ref={containerRef}
      className={cls.join(' ')}
      onMouseDown={onPanStart}
      onDoubleClick={(e) => { if (e.target === e.currentTarget) reset(); }}
    >
      <canvas ref={canvasRef} className="team-canvas__fx" />
      <div className="team-canvas__viewport" ref={viewportRef}>
        {agents.map((a) => (
          <AgentCard
            key={a.id}
            name={a.name}
            status={a.status as 'idle' | 'thinking' | 'responding' | 'offline'}
            cliType={a.cliType}
            lastMessage={a.lastMessage}
            x={a.x}
            y={a.y}
            onDragEnd={(x, y) => onAgentDragEnd?.(a.id, x, y)}
            getZoom={getZoom}
            elementRef={(el) => {
              if (el) cardEls.current.set(a.id, el);
              else cardEls.current.delete(a.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}
