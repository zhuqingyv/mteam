// gap-replayer 单测 —— 覆盖 TASK-LIST W1-C 完成判据 2/3/4/5 + REGRESSION R1-9。
// 不 mock db/bus：用 TEAM_HUB_V2_DB=:memory: 起真实 SQLite。
//
// 先设 env 再 import，走与 comm/__tests__/message-store.test.ts 一致的 pattern。

process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import type { MessageEnvelope } from '../comm/envelope.js';
import { createMessageStore, type MessageStore } from '../comm/message-store.js';
import { getDb, closeDb } from '../db/connection.js';
import { buildGapReplay, type GapReplayScope } from './gap-replayer.js';

let store: MessageStore;
let db: ReturnType<typeof getDb>;

function bootstrapFixtures(): void {
  db.exec(
    `INSERT INTO role_templates (name, role, created_at, updated_at)
     VALUES ('t', 'worker', '2026-04-25T00:00:00.000Z', '2026-04-25T00:00:00.000Z')`,
  );
  const mkInst = (id: string) =>
    db
      .prepare(
        `INSERT INTO role_instances (id, template_name, member_name, status, created_at)
         VALUES (?, 't', ?, 'ACTIVE', '2026-04-25T00:00:00.000Z')`,
      )
      .run(id, id);
  mkInst('inst_alice');
  mkInst('inst_bob');
  db.prepare(
    `INSERT INTO teams (id, name, leader_instance_id, created_at)
     VALUES ('team1', 'team1', 'inst_alice', '2026-04-25T00:00:00.000Z')`,
  ).run();
}

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'msg_x',
    from: {
      kind: 'agent',
      address: 'local:inst_alice',
      displayName: 'Alice',
      instanceId: 'inst_alice',
      memberName: 'alice',
    },
    to: {
      kind: 'agent',
      address: 'local:inst_bob',
      displayName: 'Bob',
      instanceId: 'inst_bob',
      memberName: 'bob',
    },
    teamId: 'team1',
    kind: 'chat',
    summary: 's',
    content: 'c',
    replyTo: null,
    ts: '2026-04-25T10:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

// 插入 n 条 team1 消息，ts 按分钟递增；返回按 ASC 排序的 id 数组。
function seedTeamMessages(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `msg_t${String(i).padStart(2, '0')}`;
    store.insert(
      envelope({
        id,
        ts: `2026-04-25T10:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    );
    ids.push(id);
  }
  return ids;
}

const teamSub = (id: string): GapReplayScope => ({ scope: 'team', id });

beforeEach(() => {
  closeDb();
  db = getDb();
  bootstrapFixtures();
  store = createMessageStore();
});

afterAll(() => {
  closeDb();
});

describe('gap-replayer · team scope 基础行为（完成判据 2）', () => {
  it('lastMsgId 取中间某条 → 只返 id 之后（严格 >）的消息', () => {
    const ids = seedTeamMessages(5);
    const result = buildGapReplay({ messageStore: store }, {
      lastMsgId: ids[2]!,
      sub: teamSub('team1'),
    });

    expect(result.type).toBe('gap-replay');
    expect(result.items.map((x) => x.id)).toEqual([ids[3]!, ids[4]!]);
    // 每条 item.id = envelope.id
    for (const it of result.items) {
      expect(typeof it.id).toBe('string');
      expect(it.event.messageId).toBe(it.id);
    }
    // upTo = 最新一条 id
    expect(result.upTo).toBe(ids[4]!);
  });

  it('lastMsgId = null → items=[]、upTo=null（首订阅不灌全表）', () => {
    seedTeamMessages(3);
    const result = buildGapReplay({ messageStore: store }, {
      lastMsgId: null,
      sub: teamSub('team1'),
    });
    expect(result.items).toEqual([]);
    expect(result.upTo).toBeNull();
  });

  it('无 gap（lastMsgId = 最新） → items=[]、upTo=null', () => {
    const ids = seedTeamMessages(3);
    const result = buildGapReplay({ messageStore: store }, {
      lastMsgId: ids[ids.length - 1]!,
      sub: teamSub('team1'),
    });
    expect(result.items).toEqual([]);
    expect(result.upTo).toBeNull();
  });

  it('每条 event 形状对齐 WS 白名单（type=comm.message_sent）', () => {
    seedTeamMessages(2);
    const result = buildGapReplay({ messageStore: store }, {
      lastMsgId: 'msg_t00',
      sub: teamSub('team1'),
    });
    expect(result.items.length).toBe(1);
    const ev = result.items[0]!.event;
    expect(ev.type).toBe('comm.message_sent');
    expect(ev.from).toBe('local:inst_alice');
    expect(ev.to).toBe('local:inst_bob');
    expect(ev.messageId).toBe('msg_t01');
  });
});

describe('gap-replayer · 超量翻页契约（完成判据 3 / REGRESSION R1-9）', () => {
  it('maxItems=3 插 5 条 → 第一次 items.length=3 且 upTo 指向第3条；第二次 lastMsgId=upTo 拉剩余 2 条', () => {
    const ids = seedTeamMessages(5);

    const first = buildGapReplay(
      { messageStore: store, maxItems: 3 },
      { lastMsgId: ids[0]!, sub: teamSub('team1') },
    );
    expect(first.items.map((x) => x.id)).toEqual([ids[1]!, ids[2]!, ids[3]!]);
    // upTo = 本批最后一条（第 3 条）id —— 前端续拉时 lastMsgId=upTo
    expect(first.upTo).toBe(ids[3]!);

    const second = buildGapReplay(
      { messageStore: store, maxItems: 3 },
      { lastMsgId: first.upTo, sub: teamSub('team1') },
    );
    expect(second.items.map((x) => x.id)).toEqual([ids[4]!]);
    expect(second.upTo).toBe(ids[4]!);

    const third = buildGapReplay(
      { messageStore: store, maxItems: 3 },
      { lastMsgId: second.upTo, sub: teamSub('team1') },
    );
    // 翻完 → 空
    expect(third.items).toEqual([]);
    expect(third.upTo).toBeNull();
  });
});

describe('gap-replayer · scope=global 不支持（完成判据 4）', () => {
  it('scope=global → 返回空 items、upTo=null', () => {
    seedTeamMessages(3);
    const result = buildGapReplay({ messageStore: store }, {
      lastMsgId: 'msg_t00',
      sub: { scope: 'global', id: null },
    });
    expect(result.items).toEqual([]);
    expect(result.upTo).toBeNull();
  });
});

describe('gap-replayer · scope=user 走 findUnreadForAddress（完成判据 5）', () => {
  it("scope='user:u1' → 拉 to_user_id='u1' 的未读", () => {
    // 插 3 条 to user:u1，1 条 to user:u2，1 条读过的
    const toUser = (uid: string): MessageEnvelope['to'] => ({
      kind: 'user',
      address: `user:${uid}`,
      displayName: 'U',
      instanceId: null,
      memberName: null,
    });
    store.insert(envelope({ id: 'mu1_a', ts: '2026-04-25T10:01:00.000Z', to: toUser('u1') }));
    store.insert(envelope({ id: 'mu1_b', ts: '2026-04-25T10:02:00.000Z', to: toUser('u1') }));
    store.insert(envelope({ id: 'mu2_x', ts: '2026-04-25T10:03:00.000Z', to: toUser('u2') }));
    store.insert(envelope({ id: 'mu1_c', ts: '2026-04-25T10:04:00.000Z', to: toUser('u1') }));
    // mu1_a 已读 → 不进 gap；未读中 b、c 属于 u1
    store.markRead('mu1_a');

    const result = buildGapReplay({ messageStore: store }, {
      lastMsgId: 'mu1_a', // 老的 id（可能不在当前未读集，sliceAfter 取全部）
      sub: { scope: 'user', id: 'u1' },
    });

    const ids = result.items.map((x) => x.id);
    expect(ids).toEqual(['mu1_b', 'mu1_c']);
    expect(ids).not.toContain('mu2_x'); // 越权/非目标 user 不混入
    expect(result.upTo).toBe('mu1_c');
  });
});

describe('gap-replayer · scope=instance（对称覆盖）', () => {
  it("instance:<id> → findUnreadForAddress('local:<id>') 拉未读", () => {
    store.insert(envelope({ id: 'mi_1', ts: '2026-04-25T10:01:00.000Z' }));
    store.insert(envelope({ id: 'mi_2', ts: '2026-04-25T10:02:00.000Z' }));
    const result = buildGapReplay({ messageStore: store }, {
      lastMsgId: 'mi_1',
      sub: { scope: 'instance', id: 'inst_bob' },
    });
    expect(result.items.map((x) => x.id)).toEqual(['mi_2']);
    expect(result.upTo).toBe('mi_2');
  });
});

describe('gap-replayer · W2-B 补 comm.message_received', () => {
  it('W2B-1 1 条已读 → items=[sent, received]；received.ts=readAt、route=replay', () => {
    const readAt = '2026-04-25T10:05:00.000Z';
    store.insert(envelope({ id: 'mr_1', ts: '2026-04-25T10:01:00.000Z' }));
    store.markRead('mr_1', new Date(readAt));

    const result = buildGapReplay({ messageStore: store }, {
      lastMsgId: 'nonexistent', // 让 findMessagesAfter 走退化分支，拿到最早 N 条
      sub: { scope: 'instance', id: 'inst_bob' },
    });

    expect(result.items.length).toBe(2);
    const [sent, recv] = result.items;
    expect(sent!.event.type).toBe('comm.message_sent');
    expect(sent!.id).toBe('mr_1');
    expect(recv!.event.type).toBe('comm.message_received');
    expect(recv!.id).toBe('mr_1'); // item.id 仍是 envelope id
    expect(recv!.event.messageId).toBe('mr_1');
    expect(recv!.event.ts).toBe(readAt);
    expect(recv!.event.route).toBe('replay');
    expect(recv!.event.from).toBe('local:inst_alice');
    expect(recv!.event.to).toBe('local:inst_bob');
    expect(result.upTo).toBe('mr_1');
  });

  it('W2B-2 1 未读 + 1 已读 → items 长度 3（2 sent + 1 received）', () => {
    store.insert(envelope({ id: 'mr_u', ts: '2026-04-25T10:01:00.000Z' }));
    store.insert(envelope({ id: 'mr_r', ts: '2026-04-25T10:02:00.000Z' }));
    store.markRead('mr_r', new Date('2026-04-25T10:05:00.000Z'));

    const result = buildGapReplay({ messageStore: store }, {
      lastMsgId: 'nonexistent',
      sub: { scope: 'instance', id: 'inst_bob' },
    });
    expect(result.items.length).toBe(3);
    expect(result.items.map((x) => x.event.type)).toEqual([
      'comm.message_sent',
      'comm.message_sent',
      'comm.message_received',
    ]);
    expect(result.upTo).toBe('mr_r');
  });

  it('W2B-Q4-1 maxItems=3：env1(未读,1ev) + env2(已读,2ev) + env3(已读,2ev) → items=3、upTo=env2（env3 整截）', () => {
    store.insert(envelope({ id: 'e1', ts: '2026-04-25T10:01:00.000Z' }));
    store.insert(envelope({ id: 'e2', ts: '2026-04-25T10:02:00.000Z' }));
    store.insert(envelope({ id: 'e3', ts: '2026-04-25T10:03:00.000Z' }));
    store.markRead('e2', new Date('2026-04-25T10:10:00.000Z'));
    store.markRead('e3', new Date('2026-04-25T10:11:00.000Z'));

    const result = buildGapReplay(
      { messageStore: store, maxItems: 3 },
      { lastMsgId: 'nonexistent', sub: { scope: 'instance', id: 'inst_bob' } },
    );
    expect(result.items.length).toBe(3);
    // 完整处理的 envelope：e1(sent) + e2(sent+received) = 3 items；e3 整条被截
    expect(result.items.map((x) => x.id)).toEqual(['e1', 'e2', 'e2']);
    expect(result.upTo).toBe('e2');
  });

  it('W2B-Q4-2 maxItems=1：第一个 envelope 就超限(已读 2ev) → items=[], upTo=null（本轮空，客户端下轮重试）', () => {
    store.insert(envelope({ id: 'only_read', ts: '2026-04-25T10:01:00.000Z' }));
    store.markRead('only_read', new Date('2026-04-25T10:05:00.000Z'));

    const result = buildGapReplay(
      { messageStore: store, maxItems: 1 },
      { lastMsgId: 'nonexistent', sub: { scope: 'instance', id: 'inst_bob' } },
    );
    expect(result.items).toEqual([]);
    expect(result.upTo).toBeNull();
  });

  it('W2B-Q4-3 maxItems=2：2 条未读各 1ev → items=2、upTo=env2', () => {
    store.insert(envelope({ id: 'u1', ts: '2026-04-25T10:01:00.000Z' }));
    store.insert(envelope({ id: 'u2', ts: '2026-04-25T10:02:00.000Z' }));

    const result = buildGapReplay(
      { messageStore: store, maxItems: 2 },
      { lastMsgId: 'nonexistent', sub: { scope: 'instance', id: 'inst_bob' } },
    );
    expect(result.items.map((x) => x.id)).toEqual(['u1', 'u2']);
    expect(result.upTo).toBe('u2');
  });
});

describe('gap-replayer · 非业务防漂移', () => {
  it('源文件不 import bus / comm-router / mcp / business', async () => {
    const fs = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = fileURLToPath(import.meta.url);
    const target = path.resolve(path.dirname(here), 'gap-replayer.ts');
    const src = await fs.readFile(target, 'utf8');
    // 非业务模块只允许 import type；runtime import 只能是 nodejs 内置或 ./protocol 同级。
    const runtimeImports = src
      .split('\n')
      .filter((l) => /^import\s+(?!type)/.test(l));
    // 允许无 runtime import；若有，需全部来自 node:/ 或 ./（同目录）
    for (const line of runtimeImports) {
      expect(/from ['"](node:|\.\/)/.test(line)).toBe(true);
    }
    expect(/from ['"][^'"]*bus\//.test(src)).toBe(false);
    expect(/from ['"][^'"]*comm\/router/.test(src)).toBe(false);
    expect(/from ['"][^'"]*mcp\//.test(src)).toBe(false);
  });
});
