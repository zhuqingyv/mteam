// Phase 4 共享聊天/消息类型。
// 契约见 docs/phase4/INTERFACE-CONTRACTS.md §2。
// 后续 Sprint 的 ChatPeer / CanvasNodeData / ActiveEdge 等也应集中落到这里。

import type { ToolCall } from '../molecules/ToolCallList';

export interface TurnBlockIO {
  display?: string;
  [key: string]: unknown;
}

export interface TurnBlock {
  type: 'thinking' | 'text' | 'tool_call' | 'tool_result';
  blockId: string;
  content?: string;
  toolName?: string;
  title?: string;
  status?: string;
  summary?: string;
  input?: TurnBlockIO;
  output?: TurnBlockIO;
  startTs?: string;
  updatedTs?: string;
}

export type MessageRole = 'user' | 'agent';
export type MessageKind = 'chat' | 'turn' | 'comm-in' | 'comm-out';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  time: string;
  ts?: string;
  read?: boolean;
  agentName?: string;
  thinking?: boolean;
  toolCalls?: ToolCall[];
  turnId?: string;
  blocks?: TurnBlock[];
  streaming?: boolean;
  peerId?: string;
  kind?: MessageKind;
}

export interface InstanceBucket {
  messages: Message[];
  pendingPrompts: string[];
}

export type PeerRole = 'user' | 'leader' | 'member';

export interface ChatPeer {
  id: string;
  name: string;
  avatar?: string;
  role: PeerRole;
  lastMessage?: string;
  lastTime?: string;
  unread?: number;
}
