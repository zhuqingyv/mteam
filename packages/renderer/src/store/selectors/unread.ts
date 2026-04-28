// Phase 4 S4-M2：未读统计 selector。
// 契约见 docs/phase4/INTERFACE-CONTRACTS.md §10.3。
// 消费 messageStore 由 markPeerRead 维护的 `read` 字段，不做副作用。
// 严格按 `peerId` 归属统计——markPeerRead 也只匹配 peerId，两者口径对齐。

import type { MessageState } from '../messageStore';
import { selectMessagesFor } from '../messageStore.selectors';

/** 桶中归属 `peerId` 且 `read !== true` 的消息数。 */
export function selectUnreadFor(
  state: MessageState,
  instanceId: string,
  peerId: string,
): number {
  const msgs = selectMessagesFor(state, instanceId);
  let n = 0;
  for (const m of msgs) {
    if (m.peerId === peerId && m.read !== true) n++;
  }
  return n;
}

/**
 * 桶中每个 peer 的未读计数。
 * 无 `peerId` 的消息不纳入——markPeerRead 标不到，也不存在可点开的 peer。
 */
export function selectUnreadMap(
  state: MessageState,
  instanceId: string,
): Record<string, number> {
  const msgs = selectMessagesFor(state, instanceId);
  const map: Record<string, number> = {};
  for (const m of msgs) {
    if (!m.peerId) continue;
    if (m.read === true) continue;
    map[m.peerId] = (map[m.peerId] ?? 0) + 1;
  }
  return map;
}
