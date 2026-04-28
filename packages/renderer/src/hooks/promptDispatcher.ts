// 发送 prompt 的共享调度逻辑 —— ExpandedView handleSend / handleTurnEvent 自动续发队列
// 和 CanvasNode 展开态 peer=user 发送都走这里，保证本地 echo + pending 占位 + wsClient.prompt 一致。
//
// Phase 4 按 instanceId 分桶后，所有函数都接 iid 参数；缺省 iid 回落到主 Agent instanceId，
// 保证 ExpandedView 等旧调用点零改动。排队严格按 iid 隔离：A instance 正在 streaming
// 不会阻塞 B instance 立刻发送，cancel 也只清对应 iid 自己的队列。
//
// 口径（契约 §4.2）：
// - 队列判定"真正 streaming"：对应 iid 桶里存在 `role==='agent' && streaming && !!turnId` 的消息。
//   pending-* 占位只带 streaming=true 不带 turnId，不算 streaming，保证第一条立即派发。
// - dispatchPromptNow 的 WS 调用：`client.prompt(iid, text, 'req-'+ts)`。
// - cancelCurrentTurn 的 WS 调用：`client.cancelTurn(iid, 'cancel-'+ts)`。

import { useMessageStore, usePrimaryAgentStore, useWsStore } from '../store';
import { selectMessagesFor } from '../store/messageStore.selectors';
import type { Message } from '../store/messageStore';

const fmtTime = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function resolveIid(iid: string | undefined): string | null {
  if (iid) return iid;
  return usePrimaryAgentStore.getState().instanceId ?? null;
}

export function isTurnStreaming(iid: string): boolean {
  if (!iid) return false;
  const msgs = selectMessagesFor(useMessageStore.getState(), iid);
  return msgs.some((m) => m.role === 'agent' && m.streaming === true && !!m.turnId);
}

// 立即向指定 iid 发 prompt：对应桶插入 pending 占位 + WS prompt。user echo 由调用方负责。
export function dispatchPromptNow(text: string, iid: string): void {
  if (!iid) return;
  const ms = useMessageStore.getState();
  const ts = Date.now();
  const pending: Message = {
    id: `pending-${ts}`,
    role: 'agent',
    content: '',
    time: fmtTime(),
    thinking: true,
    streaming: true,
  };
  ms.addMessageFor(iid, pending);
  const wsClient = useWsStore.getState().client;
  if (wsClient) wsClient.prompt(iid, text, `req-${ts}`);
}

// 用户输入发送 —— 先本地 echo user bubble；对应 iid 桶正在 streaming 则入队，否则立即派发。
// iid 省略 → fallback 到主 Agent instanceId；主 Agent 也没起则插入错误提示。
export function sendUserPrompt(text: string, iid?: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const targetIid = resolveIid(iid);
  const ms = useMessageStore.getState();
  if (!targetIid) {
    // 没有可用 iid（主 Agent 也没启动）：走 deprecated addMessage，
    // primaryId=null 时 store 内部 console.warn 并 no-op。UX 兜底不抛错。
    ms.addMessage({
      id: `e-${Date.now()}`,
      role: 'agent',
      content: 'Primary Agent not started.',
      time: fmtTime(),
    });
    return;
  }
  const ts = Date.now();
  const userMsg: Message = { id: `u-${ts}`, role: 'user', content: trimmed, time: fmtTime(), read: true };
  ms.addMessageFor(targetIid, userMsg);
  if (isTurnStreaming(targetIid)) {
    ms.enqueuePromptFor(targetIid, trimmed);
    return;
  }
  dispatchPromptNow(trimmed, targetIid);
}

// turn.completed / turn.error 后调用：若对应 iid 桶队列有待发消息，取一条立刻派发。
export function flushNextPending(iid: string): void {
  if (!iid) return;
  const next = useMessageStore.getState().dequeuePromptFor(iid);
  if (next === undefined) return;
  dispatchPromptNow(next, iid);
}

// 用户点停止：清指定 iid 待发队列 + 向 WS 发 cancel_turn；不影响其它 iid 的队列和 streaming。
// iid 省略 → fallback 到主 Agent instanceId。UI 状态回收走 turn.completed。
export function cancelCurrentTurn(iid?: string): void {
  const targetIid = resolveIid(iid);
  const client = useWsStore.getState().client;
  if (!targetIid || !client) return;
  useMessageStore.getState().clearPendingFor(targetIid);
  client.cancelTurn(targetIid, `cancel-${Date.now()}`);
}
