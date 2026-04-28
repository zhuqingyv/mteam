// handle-cancel 单测：driver 不存在 → not_found；driver 存在 → interrupt 被调 + ack 立即回；
// driver 不在 WORKING → 仍 ack（幂等，由 driver.interrupt 内部 noop）。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach } from 'bun:test';
import { handleCancelTurn } from './handle-cancel.js';
import { DriverRegistry } from '../agent-driver/registry.js';
import type { WsLike, WsHandlerDeps } from './ws-handler.js';
import type { AgentDriver } from '../agent-driver/driver.js';

function fakeWs(): WsLike & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: (d) => { sent.push(d); }, on: () => {}, close: () => {} };
}
const last = (ws: { sent: string[] }) => JSON.parse(ws.sent[ws.sent.length - 1] ?? 'null');

interface StubDriver { interruptCalls: number; interrupt(): Promise<void> }
const stubDriver = (): StubDriver => ({
  interruptCalls: 0,
  async interrupt() { this.interruptCalls++; },
});

let drivers: DriverRegistry;
const deps = (): WsHandlerDeps => ({ driverRegistry: drivers } as unknown as WsHandlerDeps);

beforeEach(() => { drivers = new DriverRegistry(); });

describe('handle-cancel', () => {
  it('driver 不存在 → error{not_found}', () => {
    const ws = fakeWs();
    handleCancelTurn(ws, deps(), { op: 'cancel_turn', instanceId: 'inst_ghost', requestId: 'r1' });
    expect(last(ws)).toEqual({ type: 'error', code: 'not_found', message: 'driver inst_ghost not found' });
    expect(ws.sent).toHaveLength(1);
  });

  it('driver 存在 → interrupt 被调 + ack{ok:true} 立即回', async () => {
    const drv = stubDriver();
    drivers.register('inst_a', drv as unknown as AgentDriver);
    const ws = fakeWs();
    handleCancelTurn(ws, deps(), { op: 'cancel_turn', instanceId: 'inst_a', requestId: 'req_42' });
    expect(last(ws)).toEqual({ type: 'ack', requestId: 'req_42', ok: true });
    await new Promise((r) => setImmediate(r));
    expect(drv.interruptCalls).toBe(1);
  });

  it('driver 存在但非 WORKING → 仍 ack（driver.interrupt 自己 noop）', async () => {
    const drv = stubDriver();
    drivers.register('inst_b', drv as unknown as AgentDriver);
    const ws = fakeWs();
    handleCancelTurn(ws, deps(), { op: 'cancel_turn', instanceId: 'inst_b' });
    expect(last(ws)).toEqual({ type: 'ack', requestId: '', ok: true });
  });
});
