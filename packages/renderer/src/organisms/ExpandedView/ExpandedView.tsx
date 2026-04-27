import { useCallback, useEffect, useMemo, useState } from 'react';
import ChatPanel from '../ChatPanel/ChatPanel';
import ToolBar from '../../molecules/ToolBar';
import AgentLogo from '../../atoms/AgentLogo';
import type { DropdownOption } from '../../atoms/Dropdown';
import { listCli, type CliInfo } from '../../api/cli';
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
  const currentModel = config?.cliType ?? 'claude';

  const [cliList, setCliList] = useState<CliInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    listCli().then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) setCliList(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const modelOptions = useMemo<DropdownOption[]>(
    () =>
      cliList.map((c) => ({
        value: c.name,
        label: c.name,
        icon: <AgentLogo cliType={c.name} size={14} />,
      })),
    [cliList],
  );

  const handleModelChange = useCallback((value: string) => {
    void usePrimaryAgentStore.getState().configure({ cliType: value });
  }, []);

  const handleSettings = useCallback(() => {
    window.electronAPI?.openSettings();
  }, []);

  const handleTeamPanel = useCallback(() => {
    window.electronAPI?.openTeamPanel();
  }, []);

  const handleSend = useCallback(() => {
    const text = useInputStore.getState().text.trim();
    if (!text) return;

    const iid = usePrimaryAgentStore.getState().instanceId;
    if (!iid) {
      addMessage({ id: `e-${Date.now()}`, role: 'agent', content: 'Primary Agent not started.', time: fmtTime() });
      return;
    }

    const ts = Date.now();
    const userMsg: Message = { id: `u-${ts}`, role: 'user', content: text, time: fmtTime(), read: true };
    addMessage(userMsg);
    // 先占位 thinking 气泡，避免 turn.started 到达前的空白期。
    // turn.started 会把这条 pending-* 替换成正式的 turnId 消息。
    addMessage({ id: `pending-${ts}`, role: 'agent', content: '', time: fmtTime(), thinking: true, streaming: true });
    clearText();

    // 不检查 readyState：ws.ts 的 send 内部有 pending 队列，
    // CONNECTING 期的 prompt 会在 onopen 时 flush。硬检查会静默吞消息。
    const wsClient = useWsStore.getState().client;
    if (wsClient) wsClient.prompt(iid, text, `req-${ts}`);
  }, [addMessage, clearText]);

  return (
    <div className="expanded-view">
      <ChatPanel
        messages={messages}
        inputValue={inputText}
        onInputChange={setInputText}
        onSend={handleSend}
        toolBar={
          <ToolBar
            modelOptions={modelOptions}
            currentModel={currentModel}
            onModelChange={handleModelChange}
            onSettings={handleSettings}
            onTeamPanel={handleTeamPanel}
          />
        }
      />
    </div>
  );
}
