// WS get_workers / get_worker_activity 单测。
// 不 mock db：:memory: SQLite + 真 domain 层造模板/实例/turn，FakeWs 收下行。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { EventEmitter } from 'node:events';
import { handleGetWorkers, handleGetWorkerActivity } from './handle-workers.js';
import { getDb, closeDb } from '../db/connection.js';
import { RoleTemplate } from '../domain/role-template.js';
import { RoleInstance } from '../domain/role-instance.js';
import { insertTurn } from '../turn-history/repo.js';
import type { WsLike } from './ws-handler.js';
import type { Turn } from '../agent-driver/turn-types.js';
import type {
  WsGetWorkers, WsGetWorkerActivity,
  WsGetWorkersResponse, WsGetWorkerActivityResponse,
} from './protocol.js';

interface FakeWs extends WsLike {
  sent: string[];
}

function fakeWs(): FakeWs {
  const ee = new EventEmitter();
  const sent: string[] = [];
  return {
    sent,
    send(d: string) { sent.push(d); },
    on(t, l) { ee.on(t, l as (...args: unknown[]) => void); },
    close() {},
  };
}
function last(ws: FakeWs): unknown {
  return JSON.parse(ws.sent[ws.sent.length - 1]!);
}
function mkTurn(driverId: string, text: string, endTs: string, tool = false): Turn {
  const blocks = tool
    ? [{ blockId: 'b', type: 'tool_call' as const, scope: 'turn' as const,
         status: 'done' as const, seq: 0, startTs: endTs, updatedTs: endTs,
         toolCallId: 't', title: 'ls', toolStatus: 'completed' as const,
         input: { vendor: 'claude' as const, display: 'ls', data: {} } }]
    : [];
  return { turnId: `tn-${driverId}-${endTs}`, driverId, status: 'done',
           userInput: { text, ts: endTs }, blocks, startTs: endTs, endTs };
}

beforeEach(() => { closeDb(); getDb(); });
afterAll(() => { closeDb(); });

describe('ws · get_workers', () => {
  it('空库 → workers=[] stats.total=0', () => {
    const ws = fakeWs();
    const msg: WsGetWorkers = { op: 'get_workers', requestId: 'r1' };
    handleGetWorkers(ws, msg);
    const r = last(ws) as WsGetWorkersResponse;
    expect(r.type).toBe('get_workers_response');
    expect(r.requestId).toBe('r1');
    expect(r.workers).toEqual([]);
    expect(r.stats).toEqual({ total: 0, online: 0, idle: 0, offline: 0 });
  });

  it('无实例模板 → offline；有实例未注册 → idle', () => {
    RoleTemplate.create({ name: 'alpha', role: 'dev' });
    RoleTemplate.create({ name: 'beta', role: 'dev' });
    RoleInstance.create({ templateName: 'beta', memberName: 'b1' });
    const ws = fakeWs();
    handleGetWorkers(ws, { op: 'get_workers' });
    const r = last(ws) as WsGetWorkersResponse;
    expect(r.stats.offline).toBe(1);
    expect(r.stats.idle).toBe(1);
    expect(r.workers.find((w) => w.name === 'alpha')!.status).toBe('offline');
    expect(r.workers.find((w) => w.name === 'beta')!.status).toBe('idle');
  });

  it('lastActivity 截 30 字符 + at 精确', () => {
    RoleTemplate.create({ name: 'gamma', role: 'dev' });
    const inst = RoleInstance.create({ templateName: 'gamma', memberName: 'g1' });
    insertTurn(mkTurn(inst.id, 'x'.repeat(60), '2026-04-27T10:00:00.000Z'));
    const ws = fakeWs();
    handleGetWorkers(ws, { op: 'get_workers' });
    const w = (last(ws) as WsGetWorkersResponse).workers.find((x) => x.name === 'gamma')!;
    expect(w.lastActivity!.summary.length).toBe(30);
    expect(w.lastActivity!.at).toBe('2026-04-27T10:00:00.000Z');
  });
});

describe('ws · get_worker_activity', () => {
  it('非法 range → bad_request', () => {
    const ws = fakeWs();
    const msg: WsGetWorkerActivity = { op: 'get_worker_activity', range: 'century' };
    handleGetWorkerActivity(ws, msg);
    expect(last(ws)).toMatchObject({ type: 'error', code: 'bad_request' });
  });

  it('range=day 空库 → 30 点全 0', () => {
    const ws = fakeWs();
    handleGetWorkerActivity(ws, { op: 'get_worker_activity', range: 'day', requestId: 'rq' });
    const r = last(ws) as WsGetWorkerActivityResponse;
    expect(r.type).toBe('get_worker_activity_response');
    expect(r.requestId).toBe('rq');
    expect(r.range).toBe('day');
    expect(r.workerName).toBeNull();
    expect(r.dataPoints).toHaveLength(30);
    expect(r.total).toEqual({ turns: 0, toolCalls: 0 });
  });

  it('有 turn → total.turns 计数 + toolCalls 聚合', () => {
    RoleTemplate.create({ name: 'delta', role: 'dev' });
    const inst = RoleInstance.create({ templateName: 'delta', memberName: 'd1' });
    const now = new Date().toISOString();
    insertTurn(mkTurn(inst.id, 'hi', now, true));
    insertTurn(mkTurn(inst.id, 'hi2', now.replace('Z', '1Z'), false));
    const ws = fakeWs();
    handleGetWorkerActivity(ws, { op: 'get_worker_activity', range: 'day', workerName: 'delta' });
    const r = last(ws) as WsGetWorkerActivityResponse;
    expect(r.workerName).toBe('delta');
    expect(r.total.turns).toBe(2);
    expect(r.total.toolCalls).toBe(1);
  });

  it('workerName 不匹配 → 0', () => {
    RoleTemplate.create({ name: 'eps', role: 'dev' });
    const inst = RoleInstance.create({ templateName: 'eps', memberName: 'e1' });
    insertTurn(mkTurn(inst.id, 'hi', new Date().toISOString()));
    const ws = fakeWs();
    handleGetWorkerActivity(ws, { op: 'get_worker_activity', range: 'day', workerName: 'no-such' });
    expect((last(ws) as WsGetWorkerActivityResponse).total.turns).toBe(0);
  });
});
