// W2-D send_msg 单测：不 mock。
// 对 comm 用"直接实现 CommLike"的 stub（不是 vi.mock —— 只是本地 class），
// 因为 CommLike 就是 spec；对 runLookup 走 fake fetch（同 read_message.test.ts 风格）。

import { describe, it, expect, afterEach } from 'bun:test';
import { runSendMsg, sendMsgSchema } from './send_msg.js';
import type { CommLike } from '../comm-like.js';
import type { MteamEnv } from '../config.js';

const env: MteamEnv = {
  instanceId: 'inst_self',
  hubUrl: 'http://hub.test',
  commSock: '',
  isLeader: false,
};

interface SentRecord {
  to: string;
  payload: Record<string, unknown>;
}

function makeComm(): CommLike & { sent: SentRecord[]; nextError?: Error } {
  const sent: SentRecord[] = [];
  const obj = {
    sent,
    ensureReady: async () => {},
    send: async (opts: { to: string; payload: Record<string, unknown> }): Promise<void> => {
      if (obj.nextError) throw obj.nextError;
      sent.push({ to: opts.to, payload: opts.payload });
    },
    close: () => {},
  } as CommLike & { sent: SentRecord[]; nextError?: Error };
  return obj;
}

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function installFakeFetch(handler: FetchHandler): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    return handler(url, init);
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('send_msg schema', () => {
  it('summary is optional, content is required', () => {
    const required = (sendMsgSchema.inputSchema as { required: string[] }).required;
    expect(required).toContain('to');
    expect(required).toContain('content');
    expect(required).not.toContain('summary');
  });

  it('kind enum is restricted to chat/task (no system, no broadcast)', () => {
    const props = (sendMsgSchema.inputSchema as { properties: Record<string, { enum?: readonly string[] }> }).properties;
    expect(props.kind.enum).toEqual(['chat', 'task']);
    expect(props.kind.enum).not.toContain('system');
    expect(props.kind.enum).not.toContain('broadcast');
  });

  it('exposes replyTo property', () => {
    const props = (sendMsgSchema.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.replyTo).toBeDefined();
  });

  it('additionalProperties=false', () => {
    expect((sendMsgSchema.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });
});

describe('runSendMsg · address path (no lookup)', () => {
  it('U-80: summary omitted → payload.summary defaults to "给你发了一条消息"', async () => {
    const comm = makeComm();
    const res = await runSendMsg(env, comm, { to: 'local:peer-1', content: 'hello' });
    expect(res).toEqual({ delivered: true, to: 'local:peer-1' });
    expect(comm.sent).toHaveLength(1);
    expect(comm.sent[0].payload.summary).toBe('给你发了一条消息');
    expect(comm.sent[0].payload.content).toBe('hello');
    expect(comm.sent[0].payload.kind).toBe('chat');
  });

  it('U-81: content missing → error, comm.send not called', async () => {
    const comm = makeComm();
    const res = await runSendMsg(env, comm, { to: 'local:peer-1', summary: 'only summary' });
    expect(res).toEqual({ error: 'content is required' });
    expect(comm.sent).toHaveLength(0);
  });

  it('to missing → error', async () => {
    const comm = makeComm();
    const res = await runSendMsg(env, comm, { content: 'x' });
    expect(res).toEqual({ error: 'to is required' });
    expect(comm.sent).toHaveLength(0);
  });

  it('U-82: kind="system" rejected, comm.send not called', async () => {
    const comm = makeComm();
    const res = await runSendMsg(env, comm, { to: 'local:peer-1', content: 'x', kind: 'system' });
    expect(res && typeof res === 'object' && 'error' in res).toBe(true);
    expect((res as { error: string }).error).toContain('kind');
    expect(comm.sent).toHaveLength(0);
  });

  it('kind="broadcast" rejected', async () => {
    const comm = makeComm();
    const res = await runSendMsg(env, comm, { to: 'local:peer-1', content: 'x', kind: 'broadcast' });
    expect(res && typeof res === 'object' && 'error' in res).toBe(true);
    expect(comm.sent).toHaveLength(0);
  });

  it('kind="nonsense" rejected', async () => {
    const comm = makeComm();
    const res = await runSendMsg(env, comm, { to: 'local:peer-1', content: 'x', kind: 'nonsense' });
    expect(res && typeof res === 'object' && 'error' in res).toBe(true);
    expect(comm.sent).toHaveLength(0);
  });

  it('U-83: kind="task" flows through into payload', async () => {
    const comm = makeComm();
    const res = await runSendMsg(env, comm, { to: 'local:peer-1', content: 'x', kind: 'task' });
    expect(res).toEqual({ delivered: true, to: 'local:peer-1' });
    expect(comm.sent[0].payload.kind).toBe('task');
  });

  it('U-84: replyTo flows through into payload', async () => {
    const comm = makeComm();
    const res = await runSendMsg(env, comm, {
      to: 'local:peer-1',
      summary: 're',
      content: 'x',
      replyTo: 'msg_prev_123',
    });
    expect(res).toEqual({ delivered: true, to: 'local:peer-1' });
    expect(comm.sent[0].payload.replyTo).toBe('msg_prev_123');
  });

  it('replyTo omitted → payload has no replyTo key', async () => {
    const comm = makeComm();
    await runSendMsg(env, comm, { to: 'local:peer-1', content: 'x' });
    expect('replyTo' in comm.sent[0].payload).toBe(false);
  });

  it('summary explicitly provided is preserved (not overwritten by default)', async () => {
    const comm = makeComm();
    await runSendMsg(env, comm, { to: 'local:peer-1', summary: 'custom', content: 'x' });
    expect(comm.sent[0].payload.summary).toBe('custom');
  });

  it('payload.content is set to the provided content', async () => {
    const comm = makeComm();
    await runSendMsg(env, comm, { to: 'local:peer-1', summary: 's', content: 'hello body' });
    expect(comm.sent[0].payload.content).toBe('hello body');
  });

  it('comm.send throw → returns { error: "send failed: ..." }', async () => {
    const comm = makeComm();
    comm.nextError = new Error('boom');
    const res = await runSendMsg(env, comm, { to: 'local:peer-1', content: 'x' });
    expect(res && typeof res === 'object' && 'error' in res).toBe(true);
    expect((res as { error: string }).error).toContain('send failed');
    expect((res as { error: string }).error).toContain('boom');
  });

  it('backward compat: legacy call with only {to, summary, content} still works', async () => {
    const comm = makeComm();
    const res = await runSendMsg(env, comm, {
      to: 'local:peer-1',
      summary: 'legacy',
      content: 'legacy body',
    });
    expect(res).toEqual({ delivered: true, to: 'local:peer-1' });
    expect(comm.sent[0].payload.summary).toBe('legacy');
    expect(comm.sent[0].payload.content).toBe('legacy body');
    expect(comm.sent[0].payload.kind).toBe('chat');
  });
});

describe('runSendMsg · lookup path', () => {
  let fake: ReturnType<typeof installFakeFetch> | null = null;
  afterEach(() => { fake?.restore(); fake = null; });

  it('U-86: to="老王" (alias) → runLookup is called and resolved address is used', async () => {
    const comm = makeComm();
    let lookupCalls = 0;
    fake = installFakeFetch((url) => {
      if (url.includes('/api/roster/search')) {
        lookupCalls++;
        expect(url).toContain('q=%E8%80%81%E7%8E%8B');
        return jsonResponse(200, {
          match: 'single',
          target: { address: 'local:inst_laowang', alias: '老王', memberName: 'laowang', instanceId: 'inst_laowang' },
        });
      }
      return jsonResponse(404, { error: 'not matched' });
    });
    const res = await runSendMsg(env, comm, { to: '老王', content: 'hi' });
    expect(lookupCalls).toBe(1);
    expect(res).toEqual({ delivered: true, to: 'local:inst_laowang' });
    expect(comm.sent[0].to).toBe('local:inst_laowang');
  });

  it('lookup match="none" → error, comm.send not called', async () => {
    const comm = makeComm();
    fake = installFakeFetch(() =>
      jsonResponse(200, { match: 'none', query: 'ghost' })
    );
    const res = await runSendMsg(env, comm, { to: 'ghost', content: 'x' });
    expect(res && typeof res === 'object' && 'error' in res).toBe(true);
    expect((res as { error: string }).error).toContain("no member matches 'ghost'");
    expect(comm.sent).toHaveLength(0);
  });

  it('lookup match="multiple" → error listing candidates', async () => {
    const comm = makeComm();
    fake = installFakeFetch(() =>
      jsonResponse(200, {
        match: 'multiple',
        candidates: [
          { address: 'local:a', alias: '阿强', memberName: 'aqiang', instanceId: 'a' },
          { address: 'local:b', alias: '阿强2', memberName: 'aqiang2', instanceId: 'b' },
        ],
      })
    );
    const res = await runSendMsg(env, comm, { to: '阿强', content: 'x' });
    expect(res && typeof res === 'object' && 'error' in res).toBe(true);
    const err = (res as { error: string }).error;
    expect(err).toContain('multiple');
    expect(err).toContain('阿强');
    expect(err).toContain('阿强2');
    expect(comm.sent).toHaveLength(0);
  });

  it('lookup HTTP 500 → error, comm.send not called', async () => {
    const comm = makeComm();
    fake = installFakeFetch(() => jsonResponse(500, { error: 'boom' }));
    const res = await runSendMsg(env, comm, { to: 'alias', content: 'x' });
    expect(res && typeof res === 'object' && 'error' in res).toBe(true);
    expect((res as { error: string }).error).toContain('lookup failed');
    expect(comm.sent).toHaveLength(0);
  });
});
