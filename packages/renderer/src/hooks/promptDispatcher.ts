// 发送 prompt 的共享调度逻辑 —— ExpandedView handleSend 与 handleTurnEvent
// 自动续发队列都走这里，保证本地 echo + pending 占位 + wsClient.prompt 一致。
//
// 口径：
// - 当 messageStore 里已有 turnId && streaming=true 的 agent 消息（即已进入 turn.started
//   后的真正 streaming 期），新消息排队。
// - 没有真正 streaming 的 turn 时直接发送，即使前一条刚 echo 完 pending-* 占位也不排队
//   —— 因为 turn 尚未真正开始，第一条发送就是立即发。

import { useMessageStore, usePrimaryAgentStore, useWsStore } from '../store';
import type { Message } from '../store/messageStore';

const fmtTime = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function isTurnStreaming(): boolean {
  const msgs = useMessageStore.getState().messages;
  return msgs.some((m) => m.role === 'agent' && m.streaming === true && !!m.turnId);
}

// 立即向 WS 发 prompt，并在本地插入 pending 占位气泡；user echo 由调用方负责。
export function dispatchPromptNow(text: string): void {
  const iid = usePrimaryAgentStore.getState().instanceId;
  const ms = useMessageStore.getState();
  if (!iid) {
    ms.addMessage({ id: `e-${Date.now()}`, role: 'agent', content: 'Primary Agent not started.', time: fmtTime() });
    return;
  }
  const ts = Date.now();
  ms.addMessage({ id: `pending-${ts}`, role: 'agent', content: '', time: fmtTime(), thinking: true, streaming: true });
  const wsClient = useWsStore.getState().client;
  if (wsClient) wsClient.prompt(iid, text, `req-${ts}`);
}

// 用户输入发送 —— 先本地 echo user bubble；正在 streaming 则入队，否则立即派发。
export function sendUserPrompt(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const ts = Date.now();
  const userMsg: Message = { id: `u-${ts}`, role: 'user', content: trimmed, time: fmtTime(), read: true };
  const ms = useMessageStore.getState();
  ms.addMessage(userMsg);
  if (isTurnStreaming()) {
    ms.enqueuePrompt(trimmed);
    return;
  }
  dispatchPromptNow(trimmed);
}

// turn.completed / turn.error 后调用：若队列有待发消息，取一条立刻派发。
export function flushNextPending(): void {
  const next = useMessageStore.getState().dequeuePrompt();
  if (next === undefined) return;
  dispatchPromptNow(next);
}
