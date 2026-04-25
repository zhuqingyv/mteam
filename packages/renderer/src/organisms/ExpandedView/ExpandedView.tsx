import ChatPanel from '../ChatPanel/ChatPanel';
import {
  useMessageStore,
  selectMessages,
  useAgentStore,
  selectAgents,
  selectActiveAgentId,
} from '../../store';
import './ExpandedView.css';

export default function ExpandedView() {
  const messages = useMessageStore(selectMessages);
  const agents = useAgentStore(selectAgents);
  const activeId = useAgentStore(selectActiveAgentId);
  const agentList = agents.map((a) => ({ id: a.id, name: a.name, active: a.id === activeId }));

  return (
    <div className="expanded-view">
      <button
        type="button"
        className="open-team-panel-btn"
        onClick={() => window.electronAPI?.openTeamPanel()}
      >
        打开团队面板
      </button>
      <ChatPanel messages={messages} agents={agentList} />
    </div>
  );
}
