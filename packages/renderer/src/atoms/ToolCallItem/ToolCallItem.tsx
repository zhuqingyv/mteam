import './ToolCallItem.css';

interface ToolCallItemProps {
  toolName: string;
  status: 'running' | 'done' | 'error';
  summary?: string;
  duration?: string;
}

export default function ToolCallItem({ toolName, status, summary, duration }: ToolCallItemProps) {
  return (
    <div className="tool-item">
      <span className={`tool-item__status tool-item__status--${status}`} aria-label={status} />
      <span className="tool-item__name">{toolName}</span>
      {summary && <span className="tool-item__summary">{summary}</span>}
      {duration && <span className="tool-item__duration">{duration}</span>}
    </div>
  );
}
