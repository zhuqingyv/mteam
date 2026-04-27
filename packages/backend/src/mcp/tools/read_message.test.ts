import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { runReadMessage } from './read_message.js';
import type { MteamEnv } from '../config.js';
import type { MessageEnvelope } from '../../comm/envelope.js';

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

const fakeEnvelope = {
  id: 'msg_abc',
  teamId: null,
  kind: 'chat',
  from: { kind: 'agent', address: 'local:a', displayName: 'A' },
  to: { kind: 'agent', address: 'local:b', displayName: 'B' },
  summary: 'hi',
  content: 'hello world',
  ts: '2023-11-14T22:13:20.000Z',
  readAt: null,
  replyTo: null,
  attachments: [],
} satisfies MessageEnvelope;

describe('read_message tool', () => {
  let fake: ReturnType<typeof installFakeFetch>;

  afterEach(() => {
    fake?.restore();
  });

  it('U-50: HTTP 200 returns { envelope }', async () => {
    fake = installFakeFetch(() => jsonResponse(200, { envelope: fakeEnvelope }));
    const res = await runReadMessage(env, { messageId: 'msg_abc' });
    expect(res).toEqual({ envelope: fakeEnvelope });
  });

  it('U-51: HTTP 404 returns error containing "not found"', async () => {
    fake = installFakeFetch(() => jsonResponse(404, { error: 'nope' }));
    const res = await runReadMessage(env, { messageId: 'msg_missing' });
    expect('error' in res && res.error.includes('not found')).toBe(true);
  });

  it('U-52: HTTP 403 returns error containing "forbidden"', async () => {
    fake = installFakeFetch(() => jsonResponse(403, { error: 'nope' }));
    const res = await runReadMessage(env, { messageId: 'msg_other' });
    expect('error' in res && res.error.includes('forbidden')).toBe(true);
  });

  it('U-53: HTTP 500 returns error and does not throw', async () => {
    fake = installFakeFetch(() => jsonResponse(500, { error: 'boom' }));
    let thrown: unknown;
    let res: Awaited<ReturnType<typeof runReadMessage>> | null = null;
    try {
      res = await runReadMessage(env, { messageId: 'msg_abc' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeUndefined();
    expect(res && 'error' in res).toBe(true);
  });

  it('U-54: default markRead=true when arg undefined', async () => {
    fake = installFakeFetch(() => jsonResponse(200, { envelope: fakeEnvelope }));
    await runReadMessage(env, { messageId: 'msg_abc' });
    expect(fake.calls[0]?.url).toContain('markRead=true');
  });

  it('U-55: markRead=false honored', async () => {
    fake = installFakeFetch(() => jsonResponse(200, { envelope: fakeEnvelope }));
    await runReadMessage(env, { messageId: 'msg_abc', markRead: false });
    expect(fake.calls[0]?.url).toContain('markRead=false');
  });

  it('U-56: missing messageId returns error without calling fetch', async () => {
    fake = installFakeFetch(() => jsonResponse(200, {}));
    const res = await runReadMessage(env, {});
    expect(res).toEqual({ error: 'messageId is required' });
    expect(fake.calls.length).toBe(0);
  });

  it('URL shape: GET /api/messages/:id with encoded id', async () => {
    fake = installFakeFetch(() => jsonResponse(200, { envelope: fakeEnvelope }));
    await runReadMessage(env, { messageId: 'msg with space' });
    expect(fake.calls[0]?.url).toContain('/api/messages/msg%20with%20space');
    expect(fake.calls[0]?.init?.method).toBe('GET');
  });

  it('200 with malformed body (no envelope) returns error', async () => {
    fake = installFakeFetch(() => jsonResponse(200, { notEnvelope: 1 }));
    const res = await runReadMessage(env, { messageId: 'msg_abc' });
    expect('error' in res).toBe(true);
  });
});
