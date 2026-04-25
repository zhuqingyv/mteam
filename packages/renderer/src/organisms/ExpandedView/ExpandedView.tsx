import { useCallback, useRef } from 'react';
import ChatPanel from '../ChatPanel/ChatPanel';
import {
  useMessageStore,
  selectMessages,
  selectAppendMessage,
  selectSetMessages,
  useAgentStore,
  selectAgents,
  selectActiveAgentId,
  selectSetActiveAgent,
  useInputStore,
  selectInputText,
  selectSetInputText,
  selectClearInput,
} from '../../store';
import type { Message } from '../../store/messageStore';
import './ExpandedView.css';

const MOCK_REPLIES = [
  '收到，正在处理你的请求...',
  '已完成！还需要什么帮助吗？',
  '好的，让我分析一下...',
];

const fmtTime = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function ExpandedView() {
  const messages = useMessageStore(selectMessages);
  const appendMessage = useMessageStore(selectAppendMessage);
  const setMessages = useMessageStore(selectSetMessages);

  const agents = useAgentStore(selectAgents);
  const activeId = useAgentStore(selectActiveAgentId);
  const setActiveAgent = useAgentStore(selectSetActiveAgent);

  const inputText = useInputStore(selectInputText);
  const setInputText = useInputStore(selectSetInputText);
  const clearInput = useInputStore(selectClearInput);

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const agentList = agents.map((a) => ({ id: a.id, name: a.name, active: a.id === activeId }));

  const handleSend = useCallback(() => {
    const text = useInputStore.getState().text.trim();
    if (!text) return;
    const now = fmtTime();
    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      time: now,
      read: true,
    };
    appendMessage(userMsg);
    clearInput();

    const thinkingId = `t-${Date.now()}`;
    const activeAgent = useAgentStore.getState();
    const activeAgentName =
      activeAgent.agents.find((a) => a.id === activeAgent.activeId)?.name ?? 'Agent';

    const t1 = setTimeout(() => {
      appendMessage({
        id: thinkingId,
        role: 'agent',
        content: '',
        time: fmtTime(),
        agentName: activeAgentName,
        thinking: true,
      });
    }, 1000);

    const t2 = setTimeout(() => {
      const reply = MOCK_REPLIES[Math.floor(Math.random() * MOCK_REPLIES.length)];
      const next = useMessageStore
        .getState()
        .messages.filter((m) => m.id !== thinkingId);
      setMessages([
        ...next,
        {
          id: `a-${Date.now()}`,
          role: 'agent',
          content: reply,
          time: fmtTime(),
          agentName: activeAgentName,
        },
      ]);
    }, 2000);

    timersRef.current.push(t1, t2);
  }, [appendMessage, clearInput, setMessages]);

  return (
    <div className="expanded-view">
      <button
        type="button"
        className="open-team-panel-btn"
        onClick={() => window.electronAPI?.openTeamPanel()}
      >
        打开团队面板
      </button>
      <ChatPanel
        messages={messages}
        agents={agentList}
        inputValue={inputText}
        onInputChange={setInputText}
        onSend={handleSend}
        onSelectAgent={setActiveAgent}
      />
    </div>
  );
}
