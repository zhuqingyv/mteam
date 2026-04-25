import './AgentSwitcher.css';

export interface Agent {
  id: string;
  name: string;
  icon?: string;
  active?: boolean;
}

interface AgentSwitcherProps {
  agents: Agent[];
  activeId?: string;
  onSelect?: (id: string) => void;
  onAdd?: () => void;
}

export default function AgentSwitcher({
  agents,
  activeId,
  onSelect,
  onAdd,
}: AgentSwitcherProps) {
  return (
    <div className="agent-switcher" role="tablist">
      {agents.map((a) => {
        const active = activeId ? a.id === activeId : a.active;
        return (
          <button
            key={a.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`agent-chip${active ? ' agent-chip--active' : ''}`}
            onClick={() => onSelect?.(a.id)}
          >
            {a.icon && <span className="agent-chip__icon">{a.icon}</span>}
            <span className="agent-chip__name">{a.name}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="agent-chip agent-chip--add"
        aria-label="添加"
        onClick={() => onAdd?.()}
      >
        +
      </button>
    </div>
  );
}
