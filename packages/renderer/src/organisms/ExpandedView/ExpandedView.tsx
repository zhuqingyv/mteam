import { useCallback, useEffect, useMemo, useState } from 'react';
import ChatPanel from '../ChatPanel/ChatPanel';
import ToolBar from '../../molecules/ToolBar';
import AgentLogo from '../../atoms/AgentLogo';
import type { DropdownOption } from '../../atoms/Dropdown';
import { listCli, type CliInfo } from '../../api/cli';
import {
  useMessageStore,
  selectPrimaryMessages,
  useInputStore,
  selectInputText,
  selectSetInputText,
  selectClearInput,
  usePrimaryAgentStore,
  selectPaConfig,
  selectPaInstanceId,
} from '../../store';
import {
  sendUserPrompt,
  cancelCurrentTurn,
  isTurnStreaming,
} from '../../hooks/promptDispatcher';
import './ExpandedView.css';

export default function ExpandedView() {
  const primaryIid = usePrimaryAgentStore(selectPaInstanceId);
  const messages = useMessageStore((s) => selectPrimaryMessages(s, primaryIid));

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
    window.electronAPI?.openRoleList();
  }, []);

  const handleSend = useCallback(() => {
    const text = useInputStore.getState().text;
    if (!text.trim()) return;
    // 连发支持：正在 streaming 时入队，turn.completed 后自动 flush；
    // 非 streaming 时立即本地 echo user + 插入 pending 占位 + WS prompt。
    // 显式传 primaryIid，不依赖 dispatcher 的 deprecated fallback。
    if (!primaryIid) return;
    sendUserPrompt(text, primaryIid);
    clearText();
  }, [clearText, primaryIid]);

  const handleStop = useCallback(() => {
    if (!primaryIid) return;
    cancelCurrentTurn(primaryIid);
  }, [primaryIid]);

  // 契约 §4.2：用 isTurnStreaming(iid) 权威判定，而不是自己再扫一遍 messages。
  const streaming = primaryIid ? isTurnStreaming(primaryIid) : false;

  return (
    <div className="expanded-view">
      <ChatPanel
        messages={messages}
        inputValue={inputText}
        onInputChange={setInputText}
        onSend={handleSend}
        streaming={streaming}
        onStop={handleStop}
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
