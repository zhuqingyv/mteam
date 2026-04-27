// replayForDriver 单测：用 :memory: DB + 真实 messageStore 写 envelope，
// 驱动 fake driver（不 mock db / store）。
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';

process.env.TEAM_HUB_V2_DB = ':memory:';

import type { AgentDriver } from '../../../agent-driver/driver.js';
import { RoleTemplate } from '../../../domain/role-template.js';
import { RoleInstance } from '../../../domain/role-instance.js';
import { closeDb, getDb } from '../../../db/connection.js';
import { createMessageStore } from '../../../comm/message-store.js';
import { buildEnvelope } from '../../../comm/envelope-builder.js';
import type { MessageEnvelope } from '../../../comm/envelope.js';
import { replayForDriver } from './replay.js';

const NOTIFY_RE = /^@[^>]+>.+  \[msg_id=msg_[A-Za-z0-9_-]+\]$/;

function resetDb(): void {
  closeDb();
  getDb();
  RoleTemplate.create({ name: 'tpl', role: 'worker' });
}

function seedInstance(memberName: string): string {
  const inst = RoleInstance.create({ templateName: 'tpl', memberName });
  return inst.id;
}

interface FakeDriver {
  prompts: string[];
  prompt: (text: string) => Promise<void>;
}

function fakeDriver(opts?: { failOn?: number; stopAfter?: number }): FakeDriver {
  const prompts: string[] = [];
  let n = 0;
  return {
    prompts,
    async prompt(text: string): Promise<void> {
      n += 1;
      if (opts?.failOn === n) throw new Error(`prompt #${n} boom`);
      if (opts?.stopAfter !== undefined && n > opts.stopAfter) {
        throw new Error('driver stopped');
      }
      prompts.push(text);
    },
  };
}

let tsCounter = 0;
function nextTs(): Date {
  tsCounter += 1;
  return new Date(1_700_000_000_000 + tsCounter);
}

let idCounter = 0;
function seedUnread(
  toInstId: string,
  summary: string,
  opts?: { fromInstId?: string; fromDisplay?: string },
): MessageEnvelope {
  idCounter += 1;
  const fromInstId = opts?.fromInstId;
  const fromDisplay = opts?.fromDisplay ?? 'Alice';
  const env = buildEnvelope(
    fromInstId
      ? {
          fromKind: 'agent',
          fromAddress: `local:${fromInstId}`,
          fromLookup: { instanceId: fromInstId, memberName: 'sender', displayName: fromDisplay },
          toAddress: `local:${toInstId}`,
          toLookup: { instanceId: toInstId, memberName: 'dest', displayName: 'Dest' },
          summary,
          content: `body-of-${summary}`,
          now: () => nextTs(),
          generateId: () => `msg_seed_${idCounter}`,
        }
      : {
          fromKind: 'system',
          fromAddress: 'local:system',
          fromDisplayNameOverride: fromDisplay,
          toAddress: `local:${toInstId}`,
          toLookup: { instanceId: toInstId, memberName: 'dest', displayName: 'Dest' },
          summary,
          content: `body-of-${summary}`,
          now: () => nextTs(),
          generateId: () => `msg_seed_${idCounter}`,
        },
  );
  createMessageStore().insert(env);
  return env;
}

function unreadCount(toId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM messages WHERE to_instance_id = ? AND read_at IS NULL`)
    .get(toId) as { c: number };
  return row.c;
}

describe('replayForDriver (W2-F)', () => {
  beforeEach(() => {
    resetDb();
    idCounter = 0;
  });

  afterAll(() => {
    closeDb();
  });

  it('空队列 → 0/0/0，不调 prompt', async () => {
    const id = seedInstance('alice');
    const d = fakeDriver();
    const r = await replayForDriver(id, d as unknown as AgentDriver);
    expect(r).toEqual({ total: 0, delivered: 0, failed: 0 });
    expect(d.prompts).toEqual([]);
  });

  it('E-06 核心：2 条未读回灌 → driver.prompt 都带 msg_id，均匹配通知行正则', async () => {
    const id = seedInstance('alice');
    const e1 = seedUnread(id, 'm1');
    const e2 = seedUnread(id, 'm2');
    expect(unreadCount(id)).toBe(2);

    const d = fakeDriver();
    const r = await replayForDriver(id, d as unknown as AgentDriver);

    expect(r).toEqual({ total: 2, delivered: 2, failed: 0 });
    expect(d.prompts).toHaveLength(2);
    for (const line of d.prompts) expect(line).toMatch(NOTIFY_RE);
    expect(d.prompts[0]).toContain(`[msg_id=${e1.id}]`);
    expect(d.prompts[1]).toContain(`[msg_id=${e2.id}]`);
    expect(d.prompts[0]).toContain('@Alice>m1');
    expect(unreadCount(id)).toBe(0);
  });

  it('3 条按 sent_at 顺序串行回灌 + markRead', async () => {
    const id = seedInstance('alice');
    const e1 = seedUnread(id, 'm1');
    const e2 = seedUnread(id, 'm2');
    const e3 = seedUnread(id, 'm3');
    const d = fakeDriver();
    const r = await replayForDriver(id, d as unknown as AgentDriver);
    expect(r).toEqual({ total: 3, delivered: 3, failed: 0 });
    expect(d.prompts[0]).toContain(e1.id);
    expect(d.prompts[1]).toContain(e2.id);
    expect(d.prompts[2]).toContain(e3.id);
    expect(unreadCount(id)).toBe(0);
  });

  it('某条 prompt 抛异常 → 失败条不 markRead，后续继续', async () => {
    const id = seedInstance('carol');
    const e1 = seedUnread(id, 'm1');
    const e2 = seedUnread(id, 'm2');
    const e3 = seedUnread(id, 'm3');

    const d = fakeDriver({ failOn: 2 });
    const r = await replayForDriver(id, d as unknown as AgentDriver);

    expect(r).toEqual({ total: 3, delivered: 2, failed: 1 });
    expect(unreadCount(id)).toBe(1);
    const remain = createMessageStore().findUnreadFor(id);
    expect(remain).toHaveLength(1);
    expect(remain[0]!.id).toBe(e2.id);
    // e1 / e3 已读
    const store = createMessageStore();
    expect(store.findById(e1.id)!.readAt).not.toBeNull();
    expect(store.findById(e3.id)!.readAt).not.toBeNull();
  });

  it('driver 中途 stop → 剩余消息留在 unread 等下次', async () => {
    const id = seedInstance('dan');
    seedUnread(id, 'm1');
    seedUnread(id, 'm2');
    seedUnread(id, 'm3');
    const d = fakeDriver({ stopAfter: 1 });
    const r = await replayForDriver(id, d as unknown as AgentDriver);
    expect(r.total).toBe(3);
    expect(r.delivered).toBe(1);
    expect(r.failed).toBe(2);
    expect(unreadCount(id)).toBe(2);
  });

  it('串行：后一条的 prompt 在前一条 resolve 之后才开始', async () => {
    const id = seedInstance('eve');
    seedUnread(id, 'm1');
    seedUnread(id, 'm2');

    const order: string[] = [];
    let resolveFirst: (() => void) | null = null;
    const d = {
      async prompt(text: string): Promise<void> {
        if (text.includes('m1')) {
          order.push('m1-start');
          await new Promise<void>((res) => {
            resolveFirst = res;
          });
          order.push('m1-end');
        } else {
          order.push('m2-start');
        }
      },
    } as unknown as AgentDriver;

    const done = replayForDriver(id, d);
    await Promise.resolve();
    expect(order).toEqual(['m1-start']);
    resolveFirst!();
    await done;
    expect(order).toEqual(['m1-start', 'm1-end', 'm2-start']);
  });

  it('ReplayResult 形状未漂移（lifecycle 契约）', async () => {
    const id = seedInstance('frank');
    const d = fakeDriver();
    const r = await replayForDriver(id, d as unknown as AgentDriver);
    expect(Object.keys(r).sort()).toEqual(['delivered', 'failed', 'total']);
  });
});
