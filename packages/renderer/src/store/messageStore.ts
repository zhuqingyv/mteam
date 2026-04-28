// Phase 4：按 instanceId 分桶的消息 store。
//
// 新 API：所有 action 接 iid 显式操作 byInstance[iid]；selectors 见 messageStore.selectors.ts。
// 旧 API 保留为 deprecated 代理：读镜像 primary 桶到顶层；写代理到 *For(primary iid, ...)。
// pid 为空时代理 no-op 并 console.warn。
//
// 独立模块禁 import store 的约束对本文件显式豁免（INTERFACE-CONTRACTS §3.1 / TASK-LIST 全局约束）。

import { create } from 'zustand';
import type { InstanceBucket, Message, TurnBlock } from '../types/chat';
import { usePrimaryAgentStore } from './primaryAgentStore';

export type { TurnBlockIO, TurnBlock, MessageRole, MessageKind, Message, InstanceBucket } from '../types/chat';

export interface MessageState {
  byInstance: Record<string, InstanceBucket>;

  addMessageFor: (iid: string, m: Message) => void;
  replaceMessageFor: (iid: string, id: string, m: Message) => void;
  setMessagesFor: (iid: string, list: Message[]) => void;
  clearFor: (iid: string) => void;
  updateTurnBlockFor: (iid: string, turnId: string, block: TurnBlock) => void;
  removeTurnBlocksByTypeFor: (iid: string, turnId: string, type: TurnBlock['type']) => void;
  completeTurnFor: (iid: string, turnId: string) => void;
  enqueuePromptFor: (iid: string, text: string) => void;
  dequeuePromptFor: (iid: string) => string | undefined;
  clearPendingFor: (iid: string) => void;
  markPeerRead: (iid: string, peerId: string) => void;

  // @deprecated 顶层镜像 primary 桶；新代码走 *For(iid) / selectors
  messages: Message[];
  pendingPrompts: string[];
  addMessage: (m: Message) => void;
  replaceMessage: (id: string, m: Message) => void;
  setMessages: (list: Message[]) => void;
  clear: () => void;
  updateTurnBlock: (turnId: string, block: TurnBlock) => void;
  removeTurnBlocksByType: (turnId: string, type: TurnBlock['type']) => void;
  completeTurn: (turnId: string) => void;
  enqueuePrompt: (text: string) => void;
  dequeuePrompt: () => string | undefined;
  clearPending: () => void;
}

export const MAX_MESSAGES = 1000;

const EMPTY_BUCKET: InstanceBucket = { messages: [], pendingPrompts: [] };

function pushWithCap(list: Message[], m: Message): Message[] {
  const next = [...list, m];
  return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
}

function primaryIidOrWarn(op: string): string | null {
  const iid = usePrimaryAgentStore.getState().instanceId;
  if (!iid) {
    console.warn(`[messageStore] deprecated ${op}() called but primary instanceId is null — no-op`);
    return null;
  }
  return iid;
}

// 对 byInstance[iid] 打 patch；iid === primary 时同步镜像 messages/pendingPrompts 供旧 selector。
function mutate(
  set: (fn: (s: MessageState) => Partial<MessageState>) => void,
  iid: string,
  patch: (b: InstanceBucket) => InstanceBucket,
): void {
  set((s) => {
    const cur = s.byInstance[iid] ?? EMPTY_BUCKET;
    const nb = patch(cur);
    if (nb === cur) return {};
    const byInstance = { ...s.byInstance, [iid]: nb };
    const primary = usePrimaryAgentStore.getState().instanceId;
    if (primary && primary === iid) {
      return { byInstance, messages: nb.messages, pendingPrompts: nb.pendingPrompts };
    }
    return { byInstance };
  });
}

export const useMessageStore = create<MessageState>()((set, get) => ({
  byInstance: {},
  messages: [],
  pendingPrompts: [],

  addMessageFor: (iid, m) =>
    mutate(set, iid, (b) => ({ ...b, messages: pushWithCap(b.messages, m) })),
  replaceMessageFor: (iid, id, m) =>
    mutate(set, iid, (b) => ({ ...b, messages: b.messages.map((it) => (it.id === id ? m : it)) })),
  setMessagesFor: (iid, list) =>
    mutate(set, iid, (b) => ({
      ...b,
      messages: list.length > MAX_MESSAGES ? list.slice(-MAX_MESSAGES) : list,
    })),
  clearFor: (iid) => mutate(set, iid, (b) => ({ ...b, messages: [] })),

  updateTurnBlockFor: (iid, turnId, block) =>
    mutate(set, iid, (b) => ({
      ...b,
      messages: b.messages.map((m) => {
        if (m.turnId !== turnId) return m;
        const blocks = m.blocks ?? [];
        const idx = blocks.findIndex((x) => x.blockId === block.blockId);
        return {
          ...m,
          blocks: idx >= 0 ? blocks.map((x, i) => (i === idx ? block : x)) : [...blocks, block],
        };
      }),
    })),

  removeTurnBlocksByTypeFor: (iid, turnId, type) =>
    mutate(set, iid, (b) => ({
      ...b,
      messages: b.messages.map((m) =>
        m.turnId === turnId ? { ...m, blocks: (m.blocks ?? []).filter((x) => x.type !== type) } : m,
      ),
    })),

  completeTurnFor: (iid, turnId) =>
    mutate(set, iid, (b) => ({
      ...b,
      messages: b.messages.map((m) => {
        if (m.turnId !== turnId) return m;
        const blocks = (m.blocks ?? []).filter((x) => x.type !== 'thinking');
        return { ...m, streaming: false, thinking: false, blocks };
      }),
    })),

  enqueuePromptFor: (iid, text) =>
    mutate(set, iid, (b) => ({ ...b, pendingPrompts: [...b.pendingPrompts, text] })),

  dequeuePromptFor: (iid) => {
    const bucket = get().byInstance[iid];
    if (!bucket || bucket.pendingPrompts.length === 0) return undefined;
    const [head, ...rest] = bucket.pendingPrompts;
    mutate(set, iid, (b) => ({ ...b, pendingPrompts: rest }));
    return head;
  },

  clearPendingFor: (iid) => mutate(set, iid, (b) => ({ ...b, pendingPrompts: [] })),

  markPeerRead: (iid, peerId) =>
    mutate(set, iid, (b) => ({
      ...b,
      messages: b.messages.map((m) =>
        m.peerId === peerId && m.read !== true ? { ...m, read: true } : m,
      ),
    })),

  addMessage: (m) => { const i = primaryIidOrWarn('addMessage'); if (i) get().addMessageFor(i, m); },
  replaceMessage: (id, m) => { const i = primaryIidOrWarn('replaceMessage'); if (i) get().replaceMessageFor(i, id, m); },
  setMessages: (l) => { const i = primaryIidOrWarn('setMessages'); if (i) get().setMessagesFor(i, l); },
  clear: () => { const i = primaryIidOrWarn('clear'); if (i) get().clearFor(i); },
  updateTurnBlock: (t, b) => { const i = primaryIidOrWarn('updateTurnBlock'); if (i) get().updateTurnBlockFor(i, t, b); },
  removeTurnBlocksByType: (t, k) => { const i = primaryIidOrWarn('removeTurnBlocksByType'); if (i) get().removeTurnBlocksByTypeFor(i, t, k); },
  completeTurn: (t) => { const i = primaryIidOrWarn('completeTurn'); if (i) get().completeTurnFor(i, t); },
  enqueuePrompt: (t) => { const i = primaryIidOrWarn('enqueuePrompt'); if (i) get().enqueuePromptFor(i, t); },
  dequeuePrompt: () => { const i = primaryIidOrWarn('dequeuePrompt'); return i ? get().dequeuePromptFor(i) : undefined; },
  clearPending: () => { const i = primaryIidOrWarn('clearPending'); if (i) get().clearPendingFor(i); },
}));

// primary instanceId 切换时，把新 primary 桶镜像到顶层。
usePrimaryAgentStore.subscribe((s, prev) => {
  if (s.instanceId === prev.instanceId) return;
  if (s.instanceId) {
    const b = useMessageStore.getState().byInstance[s.instanceId] ?? EMPTY_BUCKET;
    useMessageStore.setState({ messages: b.messages, pendingPrompts: b.pendingPrompts });
  } else {
    useMessageStore.setState({ messages: [], pendingPrompts: [] });
  }
});

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __useMessageStore?: typeof useMessageStore }).__useMessageStore = useMessageStore;
}

export {
  selectMessages,
  selectAddMessage,
  selectReplaceMessage,
  selectSetMessages,
  selectClearMessages,
  selectUpdateTurnBlock,
  selectCompleteTurn,
  selectPendingPrompts,
  selectEnqueuePrompt,
  selectDequeuePrompt,
  selectClearPending,
  selectMessagesFor,
  selectPendingFor,
  selectBucketFor,
  selectPrimaryMessages,
} from './messageStore.selectors';
