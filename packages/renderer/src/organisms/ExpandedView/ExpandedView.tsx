import { useCallback, useEffect, useRef } from 'react';
import ChatPanel from '../ChatPanel/ChatPanel';
import {
  useMessageStore,
  selectMessages,
  selectAddMessage,
  selectReplaceMessage,
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
  const addMessage = useMessageStore(selectAddMessage);
  const replaceMessage = useMessageStore(selectReplaceMessage);

  const agents = useAgentStore(selectAgents);
  const activeId = useAgentStore(selectActiveAgentId);
  const setActiveAgent = useAgentStore(selectSetActiveAgent);

  const inputText = useInputStore(selectInputText);
  const setInputText = useInputStore(selectSetInputText);
  const clearText = useInputStore(selectClearInput);

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const agentState = useAgentStore.getState();
    if (agentState.agents.length === 0) {
      agentState.setAgents([
        { id: 'claude', name: 'Claude', status: 'idle' },
        { id: 'codex', name: 'Codex', status: 'idle' },
        { id: 'qwen', name: 'Qwen', status: 'idle' },
        { id: 'deepseek', name: 'DeepSeek', status: 'idle' },
      ]);
      agentState.setActiveAgent('claude');
    }
    const msgState = useMessageStore.getState();
    if (msgState.messages.length === 0) {
      msgState.addMessage({
        id: 'welcome',
        role: 'agent',
        content: '你好！我是 MTEAM，你的智能开发助手。有什么可以帮你的吗？😊',
        agentName: 'Claude',
        time: '20:48',
      });
    }
  }, []);

  const agentList = agents.map((a) => ({ id: a.id, name: a.name, active: a.id === activeId }));

  const handleSend = useCallback(() => {
    const text = useInputStore.getState().text.trim();
    if (!text) return;
    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      time: fmtTime(),
      read: true,
    };
    addMessage(userMsg);
    clearText();

    const thinkingId = `t-${Date.now()}`;
    const { agents: allAgents, activeId: curId } = useAgentStore.getState();
    const activeAgentName = allAgents.find((a) => a.id === curId)?.name ?? 'Agent';

    const t1 = setTimeout(() => {
      addMessage({
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
      replaceMessage(thinkingId, {
        id: thinkingId,
        role: 'agent',
        content: reply,
        time: fmtTime(),
        agentName: activeAgentName,
      });
    }, 2000);

    timersRef.current.push(t1, t2);
  }, [addMessage, replaceMessage, clearText]);

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
