import { useMemo } from 'react';
import { useMessageStore, type TurnBlock } from '../store/messageStore';

export interface TurnState {
  turnId: string;
  instanceId: string;
  blocks: TurnBlock[];
  status: 'running' | 'completed' | 'error';
}

/**
 * Derives TurnState list from messages that carry turn blocks.
 * Pure selector -- no side-effects, no subscriptions beyond the store.
 */
export function useTurnRenderer(): TurnState[] {
  const messages = useMessageStore((s) => s.messages);

  return useMemo(
    () =>
      messages
        .filter((m): m is typeof m & { turnId: string } => !!m.turnId)
        .map((m) => ({
          turnId: m.turnId,
          instanceId: m.agentName ?? '',
          blocks: m.blocks ?? [],
          status: m.streaming ? 'running' as const : 'completed' as const,
        })),
    [messages],
  );
}
