import { useCallback } from 'react';
import ChatPanel from '../ChatPanel/ChatPanel';
import {
  useMessageStore,
  selectMessages,
  selectAddMessage,
  useInputStore,
  selectInputText,
  selectSetInputText,
  selectClearInput,
  useWsStore,
  usePrimaryAgentStore,
  selectPaConfig,
} from '../../store';
import type { Message } from '../../store/messageStore';
import './ExpandedView.css';

const fmtTime = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function ExpandedView() {
  const messages = useMessageStore(selectMessages);
  const addMessage = useMessageStore(selectAddMessage);

  const inputText = useInputStore(selectInputText);
  const setInputText = useInputStore(selectSetInputText);
  const clearText = useInputStore(selectClearInput);

  const config = usePrimaryAgentStore(selectPaConfig);

  const cliType = config?.cliType ?? 'claude';
  const agentList = [{ id: cliType, name: config?.name ?? 'MTEAM', active: true }];

  const handleSend = useCallback(() => {
    const text = useInputStore.getState().text.trim();
    if (!text) return;

    const iid = usePrimaryAgentStore.getState().instanceId;
    if (!iid) {
      addMessage({ id: `e-${Date.now()}`, role: 'agent', content: 'Primary Agent not started.', time: fmtTime() });
      return;
    }

    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: text, time: fmtTime(), read: true };
    addMessage(userMsg);
    clearText();

    const wsClient = useWsStore.getState().client;
    if (wsClient && wsClient.readyState() === WebSocket.OPEN) {
      wsClient.prompt(iid, text, `req-${Date.now()}`);
    }
  }, [addMessage, clearText]);

  return (
    <div className="expanded-view">
      <button
        type="button"
        className="open-settings-btn"
        aria-label="Settings"
        title="Settings"
        onClick={() => window.electronAPI?.openSettings()}
      >
        ⚙
      </button>
      <button
        type="button"
        className="open-team-panel-btn"
        onClick={() => window.electronAPI?.openTeamPanel()}
      >
        Team Panel
      </button>
      <ChatPanel
        messages={messages}
        agents={agentList}
        inputValue={inputText}
        onInputChange={setInputText}
        onSend={handleSend}
      />
    </div>
  );
}
