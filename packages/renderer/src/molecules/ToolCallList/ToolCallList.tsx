import { useState } from 'react';
import ToolCallItem from '../../atoms/ToolCallItem';
import './ToolCallList.css';

export interface ToolCall {
  id: string;
  toolName: string;
  status: 'running' | 'done' | 'error';
  summary?: string;
  duration?: string;
}

interface ToolCallListProps {
  calls: ToolCall[];
  defaultCollapsed?: boolean;
}

export default function ToolCallList({ calls, defaultCollapsed = false }: ToolCallListProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const visible = collapsed ? calls.slice(-1) : calls;
  return (
    <div className="tool-list">
      <button
        type="button"
        className="tool-list__header"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className={`tool-list__chevron ${collapsed ? '' : 'tool-list__chevron--open'}`}>▸</span>
        <span>工具调用</span>
        <span className="tool-list__count">{calls.length}</span>
      </button>
      <div className={`tool-list__body ${collapsed ? 'tool-list__body--collapsed' : ''}`}>
        {visible.map((c) => (
          <ToolCallItem
            key={c.id}
            toolName={c.toolName}
            status={c.status}
            summary={c.summary}
            duration={c.duration}
          />
        ))}
      </div>
    </div>
  );
}
