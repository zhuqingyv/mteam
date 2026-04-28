// WS `turn.*` 事件 → messageStore。
//
// 从 wsEventHandlers 拆出以满足单文件 ≤ 200 行门禁。
// 语义与 docs/frontend-api/turn-events.md §5 一致：
//   - turn.started      → addMessage / replace pending-* 占位气泡
//   - turn.block_updated → 按 blockId upsert，text 覆盖扁平 content 并清 thinking
//   - turn.completed    → completeTurn（收尾）
//   - turn.error        → 追加 [error] 到正文或新增一条 agent 消息

import { useMessageStore, usePrimaryAgentStore } from '../store';
import { flushNextPending } from './promptDispatcher';

const SUPPORTED_BLOCK_TYPES = ['text', 'thinking', 'tool_call', 'tool_result'] as const;
type SupportedBlock = (typeof SUPPORTED_BLOCK_TYPES)[number];

export function handleTurnEvent(t: string, e: Record<string, unknown>) {
  const pa = usePrimaryAgentStore.getState();
  const did = String(e.driverId ?? e.instanceId ?? '');
  if (pa.instanceId && did !== pa.instanceId) return;
  const ms = useMessageStore.getState();

  if (t === 'turn.started') {
    const turnId = String(e.turnId ?? '');
    if (!turnId) return;
    if (ms.messages.some((m) => m.id === turnId)) return;
    const ui = e.userInput as { ts?: string } | undefined;
    const time = String(ui?.ts ?? e.ts ?? '');
    // 若有 ExpandedView 发消息时留下的 pending-* 占位（thinking 气泡），
    // 替换为正式 turnId 消息以延续同一条气泡，避免闪烁。
    const pending = [...ms.messages].reverse().find(
      (m) => m.role === 'agent' && !m.turnId && m.id.startsWith('pending-'),
    );
    if (pending) {
      ms.replaceMessage(pending.id, {
        ...pending,
        id: turnId,
        turnId,
        content: '',
        thinking: true,
        streaming: true,
        blocks: [],
        time,
      });
      return;
    }
    ms.addMessage({
      id: turnId,
      role: 'agent',
      content: '',
      time,
      turnId,
      blocks: [],
      streaming: true,
    });
    return;
  }

  if (t === 'turn.completed') {
    const turnId = String(e.turnId ?? '');
    if (!turnId) return;
    ms.completeTurn(turnId);
    // turn 结束后把对应 iid 桶的队列下一条立刻派发出去。
    if (did) flushNextPending(did);
    return;
  }

  if (t === 'turn.error') {
    const turnId = String(e.turnId ?? '');
    if (!turnId) return;
    const message = String(e.message ?? 'turn error');
    const existing = ms.messages.find((m) => m.id === turnId);
    if (existing) {
      ms.replaceMessage(turnId, {
        ...existing,
        content: existing.content ? `${existing.content}\n\n[error] ${message}` : `[error] ${message}`,
        streaming: false,
        time: String(e.ts ?? existing.time),
      });
    } else {
      ms.addMessage({
        id: turnId,
        role: 'agent',
        content: `[error] ${message}`,
        time: String(e.ts ?? ''),
        turnId,
        streaming: false,
      });
    }
    // 出错也继续派发下一条，避免队列卡死。
    if (did) flushNextPending(did);
    return;
  }

  if (t !== 'turn.block_updated') return;
  const b = e.block as {
    blockId?: string;
    type?: string;
    content?: string;
    status?: string;
    toolStatus?: string;
    toolName?: string;
    title?: string;
    summary?: string;
    input?: { display?: string; [k: string]: unknown };
    output?: { display?: string; [k: string]: unknown };
    startTs?: string;
    updatedTs?: string;
  } | undefined;
  if (!b?.blockId || !b.type) return;
  const turnId = String(e.turnId ?? '');
  if (!turnId) return;
  if (!(SUPPORTED_BLOCK_TYPES as readonly string[]).includes(b.type)) return;
  // text 已经到过这个 turn，就不再接受后续 thinking block —— 防止
  // adapter 乱序（thinking 在 text 之后才到）导致 dots 又冒出来。
  if (b.type === 'thinking') {
    const cur = ms.messages.find((m) => m.turnId === turnId);
    if (cur?.blocks?.some((bl) => bl.type === 'text')) return;
  }
  // block 是**完整最新状态**（非 delta），按 blockId upsert 覆盖到 turn 的 blocks。
  // 后端 tool block 用 toolStatus 表达工具状态（pending/running/completed/failed），
  // 和 text/thinking 的 status 是两个字段；合并到 status 供下游消费。
  ms.updateTurnBlock(turnId, {
    blockId: b.blockId,
    type: b.type as SupportedBlock,
    content: b.content,
    toolName: b.toolName,
    title: b.title,
    status: b.toolStatus ?? b.status,
    summary: b.summary,
    input: b.input,
    output: b.output,
    startTs: b.startTs,
    updatedTs: b.updatedTs,
  });
  // 镜像：text 覆盖到扁平 content 并清 thinking；thinking 置 thinking=true。
  // 注意：updateTurnBlock 已写入最新 blocks，这里必须重新读取 store 以免覆盖它。
  if (b.type === 'text' || b.type === 'thinking') {
    // text 到达时从 blocks 里剔除所有 thinking block —— 否则 TypingDots 一直渲染。
    if (b.type === 'text') ms.removeTurnBlocksByType(turnId, 'thinking');
    const latest = useMessageStore.getState().messages.find((m) => m.turnId === turnId);
    if (latest) {
      const patch = b.type === 'text'
        ? { content: b.content ?? '', thinking: false }
        : { thinking: true };
      useMessageStore.getState().replaceMessage(latest.id, {
        ...latest,
        ...patch,
        time: String(e.ts ?? latest.time),
      });
    }
  }
}
