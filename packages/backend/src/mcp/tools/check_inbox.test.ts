import { describe, it, expect, afterEach } from 'bun:test';
import { runCheckInbox } from './check_inbox.js';
import type { MteamEnv } from '../config.js';
import type { InboxSummary } from '../../comm/message-store.js';

const env: MteamEnv = {
  instanceId: 'inst_a',
  hubUrl: 'http://hub.test',
  commSock: '',
  isLeader: false,
};

type FetchCall = { url: string; init: RequestInit | undefined };

function installFakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  calls: FetchCall[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mkSummary(id: string, summary: string): InboxSummary {
  return {
    id,
    from: {
      kind: 'agent',
      address: 'local:inst_b',
      displayName: 'Bob',
      instanceId: 'inst_b',
      memberName: 'bob',
    },
    summary,
    kind: 'chat',
    replyTo: null,
    ts: '2026-04-25T00:00:00.000Z',
    readAt: null,
  };
}

describe('check_inbox tool', () => {
  let fake: ReturnType<typeof installFakeFetch>;

  afterEach(() => {
    fake?.restore();
  });

  it('U-123 返回 3 条摘要 → 每条只含摘要字段，绝不含 content', async () => {
    const body = {
      messages: [mkSummary('msg_1', 'hi'), mkSummary('msg_2', 'meeting'), mkSummary('msg_3', 'bug')],
      total: 3,
    };
    fake = installFakeFetch(() => jsonResponse(200, body));
    const res = await runCheckInbox(env, { peek: true });

    expect('messages' in res).toBe(true);
    if (!('messages' in res)) return;
    expect(res.total).toBe(3);
    expect(res.messages).toHaveLength(3);
    for (const m of res.messages) {
      expect(Object.keys(m).sort()).toEqual(
        ['from', 'id', 'kind', 'readAt', 'replyTo', 'summary', 'ts'].sort(),
      );
      expect('content' in m).toBe(false);
    }
  });

  it('peek=true → URL 带 peek=true 且服务端不应改读态（调用方断言）', async () => {
    fake = installFakeFetch(() => jsonResponse(200, { messages: [], total: 0 }));
    await runCheckInbox(env, { peek: true });
    expect(fake.calls[0]?.url).toContain('peek=true');
    expect(fake.calls[0]?.url).toContain(`/api/role-instances/${env.instanceId}/inbox`);
  });

  it('peek 缺省 → URL 带 peek=false', async () => {
    fake = installFakeFetch(() => jsonResponse(200, { messages: [], total: 0 }));
    await runCheckInbox(env, {});
    expect(fake.calls[0]?.url).toContain('peek=false');
  });

  it('HTTP 500 → 返回 error，不抛', async () => {
    fake = installFakeFetch(() => jsonResponse(500, { error: 'boom' }));
    const res = await runCheckInbox(env, {});
    expect('error' in res).toBe(true);
  });

  it('HTTP 404 → 返回 error', async () => {
    fake = installFakeFetch(() => jsonResponse(404, { error: 'not found' }));
    const res = await runCheckInbox(env, {});
    expect('error' in res).toBe(true);
  });

  it('空 body → messages=[] total=0', async () => {
    fake = installFakeFetch(() => jsonResponse(200, {}));
    const res = await runCheckInbox(env, {});
    expect('messages' in res && res.messages).toEqual([]);
    expect('total' in res && res.total).toBe(0);
  });

  it('instanceId 含特殊字符 → 被 encode', async () => {
    fake = installFakeFetch(() => jsonResponse(200, { messages: [], total: 0 }));
    await runCheckInbox({ ...env, instanceId: 'inst/with space' }, {});
    expect(fake.calls[0]?.url).toContain('inst%2Fwith%20space');
  });
});
