// S6-M1 activeEdges selector 单测。
// 覆盖：衰减曲线 / 2s 边界 / 同边取最新 / 空态 / 无 ts 忽略。

import { describe, it, expect } from 'bun:test';
import { selectActiveEdges } from '../activeEdges';
import type { InstanceBucket, Message } from '../../../types/chat';

function msg(over: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    role: 'user',
    content: '',
    time: '',
    ...over,
  } as Message;
}

function state(buckets: Record<string, Partial<InstanceBucket>>): { byInstance: Record<string, InstanceBucket> } {
  const byInstance: Record<string, InstanceBucket> = {};
  for (const [k, v] of Object.entries(buckets)) {
    byInstance[k] = { messages: v.messages ?? [], pendingPrompts: v.pendingPrompts ?? [] };
  }
  return { byInstance };
}

const NOW = 1_700_000_000_000;

describe('selectActiveEdges', () => {
  it('空 state 返回空数组', () => {
    expect(selectActiveEdges({ byInstance: {} }, NOW)).toEqual([]);
  });

  it('只 comm-out 参与；peerId=user 或 self 被忽略', () => {
    const s = state({
      A: {
        messages: [
          msg({ id: '1', kind: 'comm-out', peerId: 'B', ts: new Date(NOW - 500).toISOString() }),
          msg({ id: '2', kind: 'comm-in', peerId: 'B', ts: new Date(NOW - 100).toISOString() }),
          msg({ id: '3', kind: 'comm-out', peerId: 'user', ts: new Date(NOW - 100).toISOString() }),
          msg({ id: '4', kind: 'comm-out', peerId: 'A', ts: new Date(NOW - 100).toISOString() }),
          msg({ id: '5', kind: 'turn', peerId: 'user', ts: new Date(NOW - 100).toISOString() }),
        ],
      },
    });
    const edges = selectActiveEdges(s, NOW);
    expect(edges.length).toBe(1);
    expect(edges[0].fromId).toBe('A');
    expect(edges[0].toId).toBe('B');
  });

  it('intensity 随 Δ 线性衰减', () => {
    const s = state({
      A: {
        messages: [
          msg({ id: '1', kind: 'comm-out', peerId: 'B', ts: new Date(NOW - 0).toISOString() }),
          msg({ id: '2', kind: 'comm-out', peerId: 'C', ts: new Date(NOW - 1000).toISOString() }),
          msg({ id: '3', kind: 'comm-out', peerId: 'D', ts: new Date(NOW - 1500).toISOString() }),
        ],
      },
    });
    const edges = selectActiveEdges(s, NOW);
    const byTo = Object.fromEntries(edges.map((e) => [e.toId, e.intensity]));
    expect(byTo.B).toBeCloseTo(1.0, 5);
    expect(byTo.C).toBeCloseTo(0.5, 5);
    expect(byTo.D).toBeCloseTo(0.25, 5);
  });

  it('Δ 超过 2000ms 的边被丢弃', () => {
    const s = state({
      A: {
        messages: [
          msg({ id: '1', kind: 'comm-out', peerId: 'B', ts: new Date(NOW - 2001).toISOString() }),
          msg({ id: '2', kind: 'comm-out', peerId: 'C', ts: new Date(NOW - 2000).toISOString() }),
        ],
      },
    });
    const edges = selectActiveEdges(s, NOW);
    const tos = edges.map((e) => e.toId).sort();
    expect(tos).toEqual(['C']);
  });

  it('同一 (from,to) 取 lastActiveTs 最新', () => {
    const oldTs = new Date(NOW - 1500).toISOString();
    const newTs = new Date(NOW - 100).toISOString();
    const s = state({
      A: {
        messages: [
          msg({ id: '1', kind: 'comm-out', peerId: 'B', ts: oldTs }),
          msg({ id: '2', kind: 'comm-out', peerId: 'B', ts: newTs }),
        ],
      },
    });
    const edges = selectActiveEdges(s, NOW);
    expect(edges.length).toBe(1);
    expect(edges[0].lastActiveTs).toBe(Date.parse(newTs));
    expect(edges[0].intensity).toBeCloseTo(0.95, 5);
  });

  it('对向边 (A→B) 与 (B→A) 互相独立', () => {
    const s = state({
      A: { messages: [msg({ id: '1', kind: 'comm-out', peerId: 'B', ts: new Date(NOW - 100).toISOString() })] },
      B: { messages: [msg({ id: '2', kind: 'comm-out', peerId: 'A', ts: new Date(NOW - 500).toISOString() })] },
    });
    const edges = selectActiveEdges(s, NOW);
    expect(edges.length).toBe(2);
    const keys = edges.map((e) => `${e.fromId}→${e.toId}`).sort();
    expect(keys).toEqual(['A→B', 'B→A']);
  });

  it('无 ts 或 ts 不可解析的消息被忽略', () => {
    const s = state({
      A: {
        messages: [
          msg({ id: '1', kind: 'comm-out', peerId: 'B' }),
          msg({ id: '2', kind: 'comm-out', peerId: 'C', ts: 'not-a-date' }),
          msg({ id: '3', kind: 'comm-out', peerId: 'D', ts: new Date(NOW - 100).toISOString() }),
        ],
      },
    });
    const edges = selectActiveEdges(s, NOW);
    expect(edges.map((e) => e.toId)).toEqual(['D']);
  });

  it('结果按 lastActiveTs 倒序', () => {
    const s = state({
      A: {
        messages: [
          msg({ id: '1', kind: 'comm-out', peerId: 'B', ts: new Date(NOW - 1500).toISOString() }),
          msg({ id: '2', kind: 'comm-out', peerId: 'C', ts: new Date(NOW - 100).toISOString() }),
          msg({ id: '3', kind: 'comm-out', peerId: 'D', ts: new Date(NOW - 500).toISOString() }),
        ],
      },
    });
    const edges = selectActiveEdges(s, NOW);
    expect(edges.map((e) => e.toId)).toEqual(['C', 'D', 'B']);
  });
});
