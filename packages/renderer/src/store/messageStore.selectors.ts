// Phase 4 selectors for messageStore.
// Per-iid 版本（selectMessagesFor / selectPendingFor / selectBucketFor）为权威接口；
// 旧顶层 selector（selectMessages / selectAddMessage / ...）继续从主 Agent 桶镜像中读取，
// 与 messageStore.ts 里的 legacy mirror 机制配套。
// 注意：本文件不 import `./messageStore` 以避免循环依赖，只 import 类型。

import type { Message, MessageState, InstanceBucket, TurnBlock } from './messageStore';

const EMPTY_BUCKET: InstanceBucket = { messages: [], pendingPrompts: [] };

// --- per-iid 权威 selector ---

export const selectBucketFor = (s: MessageState, iid: string): InstanceBucket =>
  s.byInstance[iid] ?? EMPTY_BUCKET;

export const selectMessagesFor = (s: MessageState, iid: string): Message[] =>
  selectBucketFor(s, iid).messages;

export const selectPendingFor = (s: MessageState, iid: string): string[] =>
  selectBucketFor(s, iid).pendingPrompts;

/** 主 Agent 桶便捷读取；primaryIid 为 null 时返回空数组。契约 §3.2。 */
export const selectPrimaryMessages = (s: MessageState, primaryIid: string | null): Message[] =>
  primaryIid ? selectMessagesFor(s, primaryIid) : [];

// --- deprecated 顶层 selector（保持旧 caller 零改动） ---

/** @deprecated 用 selectMessagesFor(iid) 或 selectPrimaryMessages(primaryIid) */
export const selectMessages = (s: MessageState): Message[] => s.messages;

/** @deprecated 用 selectPendingFor(iid) */
export const selectPendingPrompts = (s: MessageState): string[] => s.pendingPrompts;

/** @deprecated 用 addMessageFor(iid, m) */
export const selectAddMessage = (s: MessageState): MessageState['addMessage'] => s.addMessage;

/** @deprecated 用 replaceMessageFor(iid, id, m) */
export const selectReplaceMessage = (s: MessageState): MessageState['replaceMessage'] => s.replaceMessage;

/** @deprecated 用 setMessagesFor(iid, list) */
export const selectSetMessages = (s: MessageState): MessageState['setMessages'] => s.setMessages;

/** @deprecated 用 clearFor(iid) */
export const selectClearMessages = (s: MessageState): MessageState['clear'] => s.clear;

/** @deprecated 用 updateTurnBlockFor(iid, turnId, block) */
export const selectUpdateTurnBlock = (
  s: MessageState,
): ((turnId: string, block: TurnBlock) => void) => s.updateTurnBlock;

/** @deprecated 用 completeTurnFor(iid, turnId) */
export const selectCompleteTurn = (s: MessageState): MessageState['completeTurn'] => s.completeTurn;

/** @deprecated 用 enqueuePromptFor(iid, text) */
export const selectEnqueuePrompt = (s: MessageState): MessageState['enqueuePrompt'] => s.enqueuePrompt;

/** @deprecated 用 dequeuePromptFor(iid) */
export const selectDequeuePrompt = (s: MessageState): MessageState['dequeuePrompt'] => s.dequeuePrompt;

/** @deprecated 用 clearPendingFor(iid) */
export const selectClearPending = (s: MessageState): MessageState['clearPending'] => s.clearPending;
