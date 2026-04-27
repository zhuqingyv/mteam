import AgentCard from '../../molecules/AgentCard';
import { useCanvasTransform } from '../../hooks/useCanvasTransform';
import './TeamCanvas.css';

interface Agent {
  id: string;
  name: string;
  status: string;
  cliType?: string;
  lastMessage?: string;
  x: number;
  y: number;
}

interface TeamCanvasProps {
  agents: Agent[];
  onAgentDragEnd?: (id: string, x: number, y: number) => void;
}

export default function TeamCanvas({ agents, onAgentDragEnd }: TeamCanvasProps) {
  const { viewportRef, containerRef, onPanStart, reset, isPanning, getZoom } = useCanvasTransform();

  const cls = ['team-canvas'];
  if (isPanning) cls.push('team-canvas--panning');

  return (
    <div
      ref={containerRef}
      className={cls.join(' ')}
      onMouseDown={onPanStart}
      onDoubleClick={(e) => { if (e.target === e.currentTarget) reset(); }}
    >
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
          />
        ))}
      </div>
    </div>
  );
}
