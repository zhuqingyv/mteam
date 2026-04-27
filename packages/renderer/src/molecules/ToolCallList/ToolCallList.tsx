import { useState } from 'react';
import ToolCallItem from '../../atoms/ToolCallItem';
import Icon from '../../atoms/Icon';
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
  return (
    <div className="tool-list">
      <button
        type="button"
        className="tool-list__header"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className={`tool-list__chevron ${collapsed ? '' : 'tool-list__chevron--open'}`}>
          <Icon name="chevron" size={10} />
        </span>
        <span>工具调用</span>
        <span className="tool-list__count">{calls.length}</span>
      </button>
      {!collapsed && (
        <div className="tool-list__body">
          {calls.map((c) => (
            <ToolCallItem
              key={c.id}
              toolName={c.toolName}
              status={c.status}
              summary={c.summary}
              duration={c.duration}
            />
          ))}
        </div>
      )}
    </div>
  );
}
