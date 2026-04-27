// Turn 聚合存储层 —— 纯内存数据结构，零 bus 依赖。
//
// 职责拆分（设计文档 §7.2）：
//   turn-store.ts           →  active Map + history 环形 + block upsert 原语（本文件）
//   turn-aggregator.subscriber.ts →  订阅 driver.* 事件 → 调用 store → emit turn.*
//
// 拆分原因：single-file 实现越过 200 行红线；按「存储 vs 事件胶水」拆后
// store 纯函数化、可独立单测，subscriber 只做翻译不持状态。
//
// 不变量（与聚合器契约）：
//   - block.seq 每 turn 从 0 起，首次插入分配，此后不变（upsert 语义保证）
//   - history 按 unshift（新的在前）入队，容量上限 cap；满了丢最旧
//   - closeActive 不删 active 槽位，由 finishActive 负责搬到 history 后删除

import type {
  StopReason, TextBlock, ThinkingBlock, Turn, TurnBlock,
} from '../../agent-driver/turn-types.js';

interface ActiveState {
  turn: Turn;
  nextSeq: number;
  blockIndex: Map<string, number>;
}

export interface TurnStoreApi {
  getActive(driverId: string): Turn | null;
  getRecent(driverId: string, limit: number): Turn[];
  openTurn(turn: Turn): ActiveState | null;
  closeActiveAsCrashed(driverId: string, reason: StopReason): ActiveState | null;
  upsert(
    driverId: string,
    blockId: string,
    build: (seq: number, prev: TurnBlock | undefined) => TurnBlock,
  ): { state: ActiveState; block: TurnBlock } | null;
  finish(driverId: string, outcome: 'done' | 'error'): ActiveState | null;
  peekActive(driverId: string): ActiveState | null;
}

export function createTurnStore(historyCap: number): TurnStoreApi {
  const active = new Map<string, ActiveState>();
  const history = new Map<string, Turn[]>();

  return {
    getActive(driverId) { return active.get(driverId)?.turn ?? null; },

    getRecent(driverId, limit) {
      const arr = history.get(driverId);
      if (!arr || limit <= 0) return [];
      return arr.slice(0, limit);
    },

    peekActive(driverId) { return active.get(driverId) ?? null; },

    // 已存在 active 槽位返回 null，由调用方决定兜底策略（通常先 closeActiveAsCrashed 再重试）。
    openTurn(turn) {
      if (active.has(turn.driverId)) return null;
      const st: ActiveState = { turn, nextSeq: 0, blockIndex: new Map() };
      active.set(turn.driverId, st);
      return st;
    },

    closeActiveAsCrashed(driverId, reason) {
      const st = active.get(driverId);
      if (!st) return null;
      st.turn.status = 'error';
      st.turn.stopReason = reason;
      return st;
    },

    upsert(driverId, blockId, build) {
      const st = active.get(driverId);
      if (!st) return null;
      const idx = st.blockIndex.get(blockId);
      const prev = idx !== undefined ? st.turn.blocks[idx] : undefined;
      const seq = prev ? prev.seq : st.nextSeq++;
      let next = build(seq, prev);
      // text/thinking 流式累加：adapter 送 delta chunk，store 在已有 content 上追加，
      // 让前端 turn.block_updated 直接拿到全量、无需自拼。
      if (prev && (next.type === 'text' || next.type === 'thinking') && prev.type === next.type) {
        next = { ...next, content: ((prev as TextBlock | ThinkingBlock).content ?? '') + (next.content ?? '') };
      }
      if (idx !== undefined) st.turn.blocks[idx] = next;
      else { st.blockIndex.set(blockId, st.turn.blocks.length); st.turn.blocks.push(next); }
      return { state: st, block: next };
    },

    finish(driverId, outcome) {
      const st = active.get(driverId);
      if (!st) return null;
      st.turn.status = outcome === 'done' ? 'done' : 'error';
      st.turn.endTs = new Date().toISOString();
      // 流式 block 在 turn 关闭时统一封口 —— 前端拿到 turn.completed 后不再看 streaming 状态。
      for (const b of st.turn.blocks) if (b.status === 'streaming') b.status = 'done';
      active.delete(driverId);
      pushHistory(driverId, st.turn);
      return st;
    },
  };

  function pushHistory(driverId: string, turn: Turn): void {
    const arr = history.get(driverId) ?? [];
    arr.unshift(turn);
    if (arr.length > historyCap) arr.length = historyCap;
    history.set(driverId, arr);
  }
}
