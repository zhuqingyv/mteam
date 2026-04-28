// Phase 4 S6-M1：画布触手"活跃边"selector。
// 契约见 docs/phase4/INTERFACE-CONTRACTS.md §2 ActiveEdge / §10.2 comm.*。
//
// 口径：
// - 扫每个桶的 kind==='comm-out' 消息（A→peerId），派生边 {fromId=A, toId=peerId, ts}
// - 同一 (from,to) 取 lastActiveTs 最新者；对向边 (to,from) 是独立的
// - intensity = 1 - Δ/2000（线性衰减，clamp [0,1]）；Δ > 2000ms 的边整体丢弃
// - 消息 ts 必须可解析为 epoch ms，否则该条不参与（避免算出 NaN）

import type { ActiveEdge, InstanceBucket, Message } from '../../types/chat';

export interface ActiveEdgesState {
  byInstance: Record<string, InstanceBucket>;
}

const DECAY_MS = 2000;

function parseTs(m: Message): number | null {
  if (!m.ts) return null;
  const t = Date.parse(m.ts);
  return Number.isFinite(t) ? t : null;
}

/**
 * 从 messageStore 派生当前活跃边列表。
 * - `now` 传 Date.now()；测试里可以冻结传固定值。
 * - 返回数组顺序按 lastActiveTs 倒序（越新越前），便于渲染层截断。
 */
export function selectActiveEdges(state: ActiveEdgesState, now: number): ActiveEdge[] {
  const map = new Map<string, ActiveEdge>();

  for (const [iid, bucket] of Object.entries(state.byInstance)) {
    for (const m of bucket.messages) {
      if (m.kind !== 'comm-out') continue;
      const toId = m.peerId;
      if (!toId || toId === 'user' || toId === iid) continue;
      const ts = parseTs(m);
      if (ts == null) continue;
      const delta = now - ts;
      if (delta < 0 || delta > DECAY_MS) continue;

      const key = `${iid}→${toId}`;
      const prev = map.get(key);
      if (prev && prev.lastActiveTs >= ts) continue;
      const intensity = 1 - delta / DECAY_MS;
      map.set(key, { fromId: iid, toId, intensity, lastActiveTs: ts });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.lastActiveTs - a.lastActiveTs);
}
