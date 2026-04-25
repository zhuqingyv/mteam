import AgentCard from '../../molecules/AgentCard';
import './TeamCanvas.css';

interface Agent {
  id: string;
  name: string;
  status: string;
  lastMessage?: string;
  x: number;
  y: number;
}

interface TeamCanvasProps {
  agents: Agent[];
  onAgentDragEnd?: (id: string, x: number, y: number) => void;
}

export default function TeamCanvas({ agents, onAgentDragEnd }: TeamCanvasProps) {
  return (
    <div className="team-canvas">
      {agents.map((a) => (
        <AgentCard
          key={a.id}
          name={a.name}
          status={a.status as 'working' | 'idle' | 'shutdown'}
          lastMessage={a.lastMessage}
          x={a.x}
          y={a.y}
          onDragEnd={(x, y) => onAgentDragEnd?.(a.id, x, y)}
        />
      ))}
    </div>
  );
}
