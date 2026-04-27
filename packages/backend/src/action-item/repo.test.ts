// action-item/repo 单测 — 不 mock，:memory: 真跑 bun:sqlite。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { getDb, closeDb } from '../db/connection.js';
import {
  createItem, findById, listByAssignee, listByCreator, listPending,
  updateStatus, resolve, timeout, listOverdue, listApproachingDeadline,
} from './repo.js';
import type { CreateActionItemInput } from './types.js';

const USER = { kind: 'user' as const, id: 'alice' };
const AGENT = { kind: 'agent' as const, id: 'agent-1' };
const AGENT2 = { kind: 'agent' as const, id: 'agent-2' };

function mk(o: Partial<CreateActionItemInput> = {}): CreateActionItemInput {
  return { kind: 'task', title: 't', description: 'd', creator: USER, assignee: AGENT,
    deadline: Date.now() + 60_000, ...o };
}

beforeEach(() => { closeDb(); getDb(); });
afterAll(() => { closeDb(); });

describe('createItem + findById', () => {
  it('createItem 返回完整 row；findById 取回同样内容', () => {
    const row = createItem(mk({ id: 'it-1' }));
    expect(row.id).toBe('it-1');
    expect(row.status).toBe('pending');
    expect(row.remindedAt).toBeNull();
    expect(row.resolution).toBeNull();
    expect(row.updatedAt).toBe(row.createdAt);
    expect(row.creator).toEqual(USER);
    expect(row.assignee).toEqual(AGENT);
    expect(findById('it-1')).toEqual(row);
    expect(findById('nope')).toBeNull();
  });

  it('同 id 再 createItem 幂等（INSERT OR IGNORE）', () => {
    createItem(mk({ id: 'dup', title: 'first' }));
    const again = createItem(mk({ id: 'dup', title: 'second' }));
    expect(again.title).toBe('first'); // 第二次被 IGNORE，findById 仍返回 first
  });
});

describe('listByAssignee / listByCreator', () => {
  it('按 assignee 过滤，status 可选', () => {
    createItem(mk({ id: 'a1', assignee: AGENT, deadline: Date.now() + 10_000 }));
    createItem(mk({ id: 'a2', assignee: AGENT, deadline: Date.now() + 20_000 }));
    createItem(mk({ id: 'b1', assignee: AGENT2, deadline: Date.now() + 30_000 }));
    updateStatus('a2', 'done');
    expect(listByAssignee('agent-1').map((r) => r.id).sort()).toEqual(['a1', 'a2']);
    expect(listByAssignee('agent-1', 'pending').map((r) => r.id)).toEqual(['a1']);
  });

  it('listByCreator 按 creator 过滤', () => {
    createItem(mk({ id: 'c1', creator: USER }));
    createItem(mk({ id: 'c2', creator: { kind: 'user', id: 'bob' } }));
    expect(listByCreator('alice').map((r) => r.id)).toEqual(['c1']);
  });
});

describe('updateStatus / resolve / timeout', () => {
  it('updateStatus 改 status 并 bump updatedAt；不存在返回 null', () => {
    const row = createItem(mk({ id: 'u1' }));
    Bun.sleepSync(2);
    const after = updateStatus('u1', 'in_progress');
    expect(after!.status).toBe('in_progress');
    expect(after!.updatedAt).toBeGreaterThanOrEqual(row.updatedAt);
    expect(updateStatus('missing', 'done')).toBeNull();
  });

  it('resolve 写 done / rejected，updatedAt 即 resolvedAt', () => {
    const created = createItem(mk({ id: 'r1' }));
    Bun.sleepSync(2);
    const done = resolve('r1', 'done');
    expect(done!.status).toBe('done');
    expect(done!.updatedAt).toBeGreaterThan(created.updatedAt);

    createItem(mk({ id: 'r2' }));
    expect(resolve('r2', 'rejected')!.status).toBe('rejected');
  });

  it('timeout 写 timeout 状态', () => {
    createItem(mk({ id: 't1' }));
    expect(timeout('t1')!.status).toBe('timeout');
  });
});

describe('listPending / listOverdue / listApproachingDeadline', () => {
  it('listPending 只含 pending / in_progress', () => {
    const now = Date.now();
    createItem(mk({ id: 'p1', deadline: now + 10_000 }));
    createItem(mk({ id: 'p2', deadline: now + 20_000 }));
    createItem(mk({ id: 'p3', deadline: now + 30_000 }));
    updateStatus('p2', 'in_progress');
    resolve('p3', 'done');
    expect(listPending().map((r) => r.id).sort()).toEqual(['p1', 'p2']);
  });

  it('listOverdue: deadline < now 且 status ∈ pending/in_progress', () => {
    const base = Date.now() + 60_000;
    createItem(mk({ id: 'o1', deadline: base }));
    createItem(mk({ id: 'o2', deadline: base + 1000 }));
    createItem(mk({ id: 'o3', deadline: base }));
    resolve('o3', 'done');
    expect(listOverdue(base + 10_000).map((r) => r.id).sort()).toEqual(['o1', 'o2']);
  });

  it('listApproachingDeadline: 剩余比例 <= ratio 且 reminded_at NULL', () => {
    createItem(mk({ id: 'd1', deadline: Date.now() + 1000 }));
    createItem(mk({ id: 'd2', deadline: Date.now() + 1000 }));
    const now = Date.now();
    // 刚建：remainingRatio ≈ 1，ratio=1.5 必全命中
    expect(listApproachingDeadline(now + 50, 1.5).map((r) => r.id).sort()).toEqual(['d1', 'd2']);
    // ratio=0 + deadline 仍在未来 → 无命中
    expect(listApproachingDeadline(now, 0)).toHaveLength(0);
    // 标记 d1 reminded_at 后只剩 d2
    getDb().prepare('UPDATE action_items SET reminded_at = ? WHERE id = ?').run(now, 'd1');
    expect(listApproachingDeadline(now + 50, 1.5).map((r) => r.id)).toEqual(['d2']);
  });

  it('listApproachingDeadline 不命中已过 deadline（留给 listOverdue）', () => {
    const row = createItem(mk({ id: 'past', deadline: Date.now() + 5_000 }));
    expect(listApproachingDeadline(row.deadline + 1, 1.5)).toHaveLength(0);
  });
});
