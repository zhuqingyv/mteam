// message-store 单测 — 覆盖 REGRESSION W1-C U-30 ~ U-44。
// 不 mock：用 TEAM_HUB_V2_DB=:memory: 起真实 SQLite；FK 约束打开。

// IMPORTANT: 先设好 env 再 import，因为 connection.ts 在 import 时还不会初始化 DB，
// 但 getDb() 第一次调用才 new Database，我们在 beforeEach closeDb 后下一次调用自然拿到 :memory:。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import type { MessageEnvelope } from '../envelope.js';
import { createMessageStore, type MessageStore } from '../message-store.js';
import { getDb, closeDb } from '../../db/connection.js';

let store: MessageStore;
let db: ReturnType<typeof getDb>;

// messages.to_instance_id FK → role_instances(id)；messages.team_id FK → teams(id)
// 每个测试前插好几条 fixture instance / team，省得每条 case 重复。
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
  mkInst('inst_carol');
  db.prepare(
    `INSERT INTO teams (id, name, leader_instance_id, created_at)
     VALUES ('team1', 'team1', 'inst_alice', '2026-04-25T00:00:00.000Z')`,
  ).run();
}

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'msg_u01',
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

beforeEach(() => {
  closeDb();
  db = getDb();
  bootstrapFixtures();
  store = createMessageStore();
});

afterAll(() => {
  closeDb();
});

describe('message-store insert / findById', () => {
  it('U-30 insert 新 envelope → dbId>0 且 messages 表 +1', () => {
    const id = store.insert(envelope());
    expect(id).toBeGreaterThan(0);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('U-31 insert 同 envelope_uuid 两次 → 返回同 dbId，messages 只 +1', () => {
    const id1 = store.insert(envelope({ id: 'msg_same' }));
    const id2 = store.insert(envelope({ id: 'msg_same', content: 'ignored' }));
    expect(id1).toBe(id2);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('U-32 findById 命中 → 完整 envelope 字段一致', () => {
    const env = envelope({
      id: 'msg_find',
      summary: 'hello',
      content: 'world',
      attachments: [{ type: 'file', name: 'a.pdf' }],
    });
    store.insert(env);
    const out = store.findById('msg_find');
    expect(out).not.toBeNull();
    expect(out!.id).toBe('msg_find');
    expect(out!.summary).toBe('hello');
    expect(out!.content).toBe('world');
    expect(out!.from.kind).toBe('agent');
    expect(out!.from.displayName).toBe('Alice');
    expect(out!.to.displayName).toBe('Bob');
    expect(out!.teamId).toBe('team1');
    expect(out!.attachments).toEqual([{ type: 'file', name: 'a.pdf' }]);
  });

  it('U-33 findById 未命中 → null', () => {
    expect(store.findById('nope')).toBeNull();
  });
});

describe('message-store markRead', () => {
  it('U-34 首次 markRead 未读消息 → 返回 1，read_at 写入', () => {
    store.insert(envelope({ id: 'msg_r1' }));
    const n = store.markRead('msg_r1', new Date('2026-04-25T11:00:00.000Z'));
    expect(n).toBe(1);
    const row = db
      .prepare('SELECT read_at FROM messages WHERE envelope_uuid = ?')
      .get('msg_r1') as { read_at: string } | undefined;
    expect(row?.read_at).toBe('2026-04-25T11:00:00.000Z');
  });

  it('U-35 已读消息再 markRead → 返回 0，read_at 不变', () => {
    store.insert(envelope({ id: 'msg_r2' }));
    const first = new Date('2026-04-25T11:00:00.000Z');
    store.markRead('msg_r2', first);
    const n = store.markRead('msg_r2', new Date('2026-04-25T12:00:00.000Z'));
    expect(n).toBe(0);
    const row = db
      .prepare('SELECT read_at FROM messages WHERE envelope_uuid = ?')
      .get('msg_r2') as { read_at: string };
    expect(row.read_at).toBe('2026-04-25T11:00:00.000Z');
  });
});

describe('message-store listInbox', () => {
  beforeEach(() => {
    for (let i = 0; i < 3; i += 1) {
      store.insert(
        envelope({
          id: `msg_i${i}`,
          ts: `2026-04-25T10:0${i}:00.000Z`,
        }),
      );
    }
  });

  it('U-36 peek=true 不改 read_at', () => {
    const r = store.listInbox('inst_bob', { peek: true });
    expect(r.messages.length).toBe(3);
    expect(r.total).toBe(3);
    const unread = (db
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE read_at IS NULL')
      .get() as { c: number }).c;
    expect(unread).toBe(3);
  });

  it('U-37 peek=false 批量改 read_at', () => {
    const r = store.listInbox('inst_bob', { peek: false });
    expect(r.messages.length).toBe(3);
    const unread = (db
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE read_at IS NULL')
      .get() as { c: number }).c;
    expect(unread).toBe(0);
  });

  it('U-38 返回结构不含 content 字段（只返摘要）', () => {
    const r = store.listInbox('inst_bob', { peek: true });
    for (const m of r.messages) {
      expect('content' in m).toBe(false);
    }
  });

  it('U-39 limit=2 时 total 仍为全量未读', () => {
    // 再插 2 条共 5 条
    store.insert(envelope({ id: 'msg_i3', ts: '2026-04-25T10:03:00.000Z' }));
    store.insert(envelope({ id: 'msg_i4', ts: '2026-04-25T10:04:00.000Z' }));
    const r = store.listInbox('inst_bob', { peek: true, limit: 2 });
    expect(r.messages.length).toBe(2);
    expect(r.total).toBe(5);
  });
});

describe('message-store listTeamHistory', () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i += 1) {
      store.insert(
        envelope({
          id: `msg_t${i}`,
          ts: `2026-04-25T10:0${i}:00.000Z`,
        }),
      );
    }
  });

  it('U-40 before=第3条 → 返回第1、2 条；hasMore=false', () => {
    // 按 id DESC，全量是 [t4, t3, t2, t1, t0]
    // before='msg_t2' → 取 id < msg_t2.id → [t1, t0]
    const r = store.listTeamHistory('team1', { before: 'msg_t2', limit: 10 });
    expect(r.items.map((x) => x.id)).toEqual(['msg_t1', 'msg_t0']);
    expect(r.hasMore).toBe(false);
    expect(r.nextBefore).toBeNull();
  });

  it('U-41 limit=2 → hasMore=true', () => {
    const r = store.listTeamHistory('team1', { limit: 2 });
    expect(r.items.length).toBe(2);
    expect(r.hasMore).toBe(true);
    expect(r.nextBefore).not.toBeNull();
  });
});

describe('message-store findUnreadFor', () => {
  it('U-42 返回完整 MessageEnvelope 数组（不是 Message）', () => {
    store.insert(envelope({ id: 'msg_u1', content: 'full' }));
    store.insert(envelope({ id: 'msg_u2', content: 'body2' }));
    const list = store.findUnreadFor('inst_bob');
    expect(list.length).toBe(2);
    const first = list[0]!;
    // 与 MessageEnvelope 结构对齐，不是底层 Message（没有 payload）
    expect(first.kind).toBeDefined();
    expect(first.from.kind).toBe('agent');
    expect(first.content).toBeDefined();
    expect((first as unknown as { payload?: unknown }).payload).toBeUndefined();
  });

  it('U-43 已读不返，只返未读', () => {
    store.insert(envelope({ id: 'msg_r', ts: '2026-04-25T10:00:00.000Z' }));
    store.insert(envelope({ id: 'msg_u1', ts: '2026-04-25T10:01:00.000Z' }));
    store.insert(envelope({ id: 'msg_u2', ts: '2026-04-25T10:02:00.000Z' }));
    store.markRead('msg_r');
    const list = store.findUnreadFor('inst_bob');
    expect(list.map((e) => e.id).sort()).toEqual(['msg_u1', 'msg_u2']);
  });
});

describe('message-store agent→user 消息（to_instance_id nullable）', () => {
  it('U-45 to.kind=user 时 to_instance_id 落 NULL、to_user_id 写入，不再因 NOT NULL 报错', () => {
    const env = envelope({
      id: 'msg_to_user',
      to: {
        kind: 'user',
        address: 'user:local',
        displayName: 'User',
        instanceId: null,
        memberName: null,
      },
    });
    const id = store.insert(env);
    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare(
        'SELECT to_instance_id, to_user_id, to_kind FROM messages WHERE envelope_uuid = ?',
      )
      .get('msg_to_user') as
      | { to_instance_id: string | null; to_user_id: string | null; to_kind: string }
      | undefined;
    expect(row?.to_instance_id).toBeNull();
    expect(row?.to_user_id).toBe('local');
    expect(row?.to_kind).toBe('user');

    const back = store.findById('msg_to_user');
    expect(back).not.toBeNull();
    expect(back!.to.kind).toBe('user');
    expect(back!.to.instanceId).toBeNull();
    expect(back!.to.address).toBe('user:local');
  });
});

describe('message-store findMessagesAfter (W2-B.0)', () => {
  const toUser = (uid: string): MessageEnvelope['to'] => ({
    kind: 'user',
    address: `user:${uid}`,
    displayName: 'U',
    instanceId: null,
    memberName: null,
  });
  const toSystem = (): MessageEnvelope['to'] => ({
    kind: 'system',
    address: 'local:system',
    displayName: 'sys',
    instanceId: null,
    memberName: null,
  });

  it('U-F1 user 地址按序返全部（含已读）', () => {
    store.insert(envelope({ id: 'mfa_u1', ts: '2026-04-25T10:01:00.000Z', to: toUser('u1') }));
    store.insert(envelope({ id: 'mfa_u2', ts: '2026-04-25T10:02:00.000Z', to: toUser('u1') }));
    store.insert(envelope({ id: 'mfa_u3', ts: '2026-04-25T10:03:00.000Z', to: toUser('u1') }));
    store.markRead('mfa_u2'); // 已读也应返回
    const list = store.findMessagesAfter('user:u1', 'mfa_u1', 10);
    expect(list.map((e) => e.id)).toEqual(['mfa_u2', 'mfa_u3']);
    // 已读那条 readAt 非空，gap-replayer 要靠这个判断是否吐 received
    expect(list[0]!.readAt).not.toBeNull();
    expect(list[1]!.readAt).toBeNull();
  });

  it('U-F2 local:<instId> 地址按序返（含已读）', () => {
    store.insert(envelope({ id: 'mfa_i1', ts: '2026-04-25T10:01:00.000Z' }));
    store.insert(envelope({ id: 'mfa_i2', ts: '2026-04-25T10:02:00.000Z' }));
    store.insert(envelope({ id: 'mfa_i3', ts: '2026-04-25T10:03:00.000Z' }));
    store.markRead('mfa_i3');
    const list = store.findMessagesAfter('local:inst_bob', 'mfa_i1', 10);
    expect(list.map((e) => e.id)).toEqual(['mfa_i2', 'mfa_i3']);
  });

  it('U-F3 local:system 命中 to_kind=system AND to_instance_id IS NULL', () => {
    store.insert(envelope({ id: 'mfa_s1', ts: '2026-04-25T10:01:00.000Z', to: toSystem() }));
    store.insert(envelope({ id: 'mfa_s2', ts: '2026-04-25T10:02:00.000Z', to: toSystem() }));
    // 噪声：发给 instance 的不应混入
    store.insert(envelope({ id: 'mfa_ni', ts: '2026-04-25T10:03:00.000Z' }));
    const list = store.findMessagesAfter('local:system', 'mfa_s1', 10);
    expect(list.map((e) => e.id)).toEqual(['mfa_s2']);
  });

  it('U-F4 同毫秒联合游标 (sent_at, id) 防漏/重', () => {
    // 同 sent_at、id 递增的两条；以第一条为游标，应只返第二条
    const sameTs = '2026-04-25T10:00:00.000Z';
    store.insert(envelope({ id: 'mfa_c1', ts: sameTs }));
    store.insert(envelope({ id: 'mfa_c2', ts: sameTs }));
    const list = store.findMessagesAfter('local:inst_bob', 'mfa_c1', 10);
    expect(list.map((e) => e.id)).toEqual(['mfa_c2']);
  });

  it('U-F5 afterMsgId 不存在 → 退化为"最早 limit 条"（不抛）', () => {
    store.insert(envelope({ id: 'mfa_e1', ts: '2026-04-25T10:01:00.000Z' }));
    store.insert(envelope({ id: 'mfa_e2', ts: '2026-04-25T10:02:00.000Z' }));
    const list = store.findMessagesAfter('local:inst_bob', 'nonexistent_id', 10);
    expect(list.map((e) => e.id)).toEqual(['mfa_e1', 'mfa_e2']);
  });

  it('U-F6 未知 address 前缀 → 空数组不抛', () => {
    store.insert(envelope({ id: 'mfa_w1', ts: '2026-04-25T10:01:00.000Z' }));
    const list = store.findMessagesAfter('weird:foo', 'anything', 10);
    expect(list).toEqual([]);
  });

  it('U-F7 limit 生效', () => {
    store.insert(envelope({ id: 'mfa_l1', ts: '2026-04-25T10:01:00.000Z' }));
    store.insert(envelope({ id: 'mfa_l2', ts: '2026-04-25T10:02:00.000Z' }));
    store.insert(envelope({ id: 'mfa_l3', ts: '2026-04-25T10:03:00.000Z' }));
    const list = store.findMessagesAfter('local:inst_bob', 'nonexistent', 2);
    expect(list.map((e) => e.id)).toEqual(['mfa_l1', 'mfa_l2']);
  });
});

describe('message-store 非业务检查', () => {
  it('U-44 源文件不 import bus/comm-router/mcp', async () => {
    const fs = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = fileURLToPath(import.meta.url);
    const target = path.resolve(path.dirname(here), '..', 'message-store.ts');
    const src = await fs.readFile(target, 'utf8');
    // 按 REGRESSION U-44：grep "bus/\|comm/router\|mcp/" 零匹配
    expect(/from ['"][^'"]*bus\//.test(src)).toBe(false);
    expect(/from ['"][^'"]*comm\/router/.test(src)).toBe(false);
    expect(/from ['"][^'"]*mcp\//.test(src)).toBe(false);
  });
});
