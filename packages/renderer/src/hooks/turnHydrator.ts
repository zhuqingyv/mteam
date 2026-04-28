// Turn 快照/冷历史 → messageStore 的还原逻辑（per-instance 分桶版）。
//
// 职责：
// - `applyTurnsResponse(driverId, msg)`：热快照（active + recent）写入 `byInstance[driverId]`。
// - `applyTurnHistoryResponse(driverId, msg)`：冷历史分页写入 `byInstance[driverId]`。
//
// 两个 API 均显式接 driverId，不再隐式 fallback 到 primary instance。

import type { TurnHistoryResponseMessage, TurnsResponseMessage } from '../api/ws';
import type { Turn, TurnBlock as ApiTurnBlock } from '../api/driver-turns';
import { useMessageStore } from '../store';
import type { Message, TurnBlock as StoreTurnBlock } from '../store/messageStore';

// Turn.blocks（后端全量）→ messageStore.TurnBlock（前端只认 text/thinking/tool_call/tool_result）。
// 与 wsEventHandlers.handleTurnEvent 的白名单保持一致。
function toIO(v: unknown): { display?: string; [k: string]: unknown } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  return v as { display?: string; [k: string]: unknown };
}

function mapBlocks(blocks: ApiTurnBlock[]): StoreTurnBlock[] {
  const out: StoreTurnBlock[] = [];
  for (const b of blocks) {
    const type = b.type;
    if (type !== 'text' && type !== 'thinking' && type !== 'tool_call' && type !== 'tool_result') continue;
    const blockId = typeof b.blockId === 'string' ? b.blockId : '';
    if (!blockId) continue;
    out.push({
      blockId,
      type,
      content: typeof b.content === 'string' ? b.content : undefined,
      toolName: typeof b.toolName === 'string' ? b.toolName : undefined,
      title: typeof b.title === 'string' ? b.title : undefined,
      status: typeof b.toolStatus === 'string' ? b.toolStatus : typeof b.status === 'string' ? b.status : undefined,
      summary: typeof b.summary === 'string' ? b.summary : undefined,
      input: toIO(b.input),
      output: toIO(b.output),
      startTs: typeof b.startTs === 'string' ? b.startTs : undefined,
      updatedTs: typeof b.updatedTs === 'string' ? b.updatedTs : undefined,
    });
  }
  return out;
}

// 把 active turn 还原到指定 bucket：若桶内已有同 turnId 的消息则 replace，否则 add。
function restoreActiveTurn(iid: string, turn: Turn) {
  const ms = useMessageStore.getState();
  const bucket = ms.byInstance[iid];
  const rawBlocks = mapBlocks(turn.blocks);
  const textBlock = rawBlocks.find((b) => b.type === 'text');
  const thinkingBlock = rawBlocks.find((b) => b.type === 'thinking');
  // text 一旦出现，thinking 就该从 blocks 清除（与实时事件逻辑对齐）。
  const blocks = textBlock ? rawBlocks.filter((b) => b.type !== 'thinking') : rawBlocks;
  const flatContent = textBlock?.content ?? '';
  // TurnStatus 'active' = 正在进行；'done'/'error' 已收尾。
  const streaming = turn.status === 'active';
  const existing = bucket?.messages.find((m) => m.turnId === turn.turnId);
  const msg: Message = {
    id: turn.turnId,
    role: 'agent',
    content: flatContent,
    time: turn.userInput?.ts ?? turn.startTs ?? '',
    turnId: turn.turnId,
    blocks,
    streaming,
    thinking: !textBlock && !!thinkingBlock,
  };
  if (existing) ms.replaceMessageFor(iid, existing.id, { ...existing, ...msg });
  else ms.addMessageFor(iid, msg);
}

// recent（已结束）若桶内还在 streaming，强制收尾 —— 防止错过 turn.completed 事件悬挂。
function reconcileRecentTurns(iid: string, recent: Turn[]) {
  const ms = useMessageStore.getState();
  const bucket = ms.byInstance[iid];
  if (!bucket) return;
  for (const t of recent) {
    const existing = bucket.messages.find((m) => m.turnId === t.turnId);
    if (!existing || existing.streaming === false) continue;
    ms.completeTurnFor(iid, t.turnId);
  }
}

export function applyTurnsResponse(driverId: string, msg: TurnsResponseMessage) {
  if (msg.active && msg.active.driverId === driverId) restoreActiveTurn(driverId, msg.active);
  if (msg.recent?.length) reconcileRecentTurns(driverId, msg.recent);
}

// 冷历史 Turn → 2 条 Message：userInput 还原 user 消息，turn 本身还原 agent 消息。
function turnToMessages(turn: Turn): Message[] {
  const blocks = mapBlocks(turn.blocks).filter((b) => b.type !== 'thinking');
  const textBlock = blocks.find((b) => b.type === 'text');
  const userTs = turn.userInput?.ts ?? turn.startTs ?? '';
  const userText = typeof turn.userInput?.text === 'string' ? turn.userInput.text : '';
  const userMsg: Message = {
    id: `u-${turn.turnId}`,
    role: 'user',
    content: userText,
    time: userTs,
    read: true,
  };
  const agentMsg: Message = {
    id: turn.turnId,
    role: 'agent',
    content: textBlock?.content ?? '',
    time: turn.endTs ?? turn.startTs ?? userTs,
    turnId: turn.turnId,
    blocks,
    streaming: false,
    thinking: false,
  };
  return userText ? [userMsg, agentMsg] : [agentMsg];
}

// 冷历史 → byInstance[driverId]。后端 items 按 endTs DESC 返回，渲染按时间升序（旧→新）。
// 已有同 turnId 的消息跳过，避免覆盖 active turn 或 WS 事件流里的 streaming 态。
export function applyTurnHistoryResponse(driverId: string, msg: TurnHistoryResponseMessage) {
  const items = msg.items ?? [];
  if (!items.length) return;
  const ms = useMessageStore.getState();
  const bucket = ms.byInstance[driverId];
  const current = bucket?.messages ?? [];
  const existingTurnIds = new Set(current.filter((m) => m.turnId).map((m) => m.turnId));
  const asc = [...items].reverse();
  const additions: Message[] = [];
  for (const turn of asc) {
    if (existingTurnIds.has(turn.turnId)) continue;
    additions.push(...turnToMessages(turn));
  }
  if (!additions.length) return;
  // 历史先于实时消息：prepend 到当前桶前。
  ms.setMessagesFor(driverId, [...additions, ...current]);
}
