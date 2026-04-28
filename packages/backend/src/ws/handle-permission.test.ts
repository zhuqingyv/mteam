// handle-permission pending map 单测：create+resolve 路径、超时 reject、cancelAll、
// resolve 不存在的 requestId 返回 false。测试共享全局 pending，afterEach 调 cancelAllPending 防串扰。
process.env.TEAM_HUB_V2_DB = ':memory:';

import { describe, it, expect, afterEach } from 'bun:test';
import {
  createPendingPermission,
  resolvePermission,
  cancelAllPending,
  pendingSize,
  handlePermissionResponse,
} from './handle-permission.js';
import type { WsLike } from './ws-handler.js';

function fakeWs(): WsLike & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: (d) => { sent.push(d); }, on: () => {}, close: () => {} };
}
const last = (ws: { sent: string[] }) => JSON.parse(ws.sent[ws.sent.length - 1] ?? 'null');

afterEach(() => {
  try { cancelAllPending('test cleanup'); } catch { /* pending 的 reject 已被下面 .catch 吞 */ }
});

describe('handle-permission pending map', () => {
  it('createPendingPermission + resolvePermission → resolve 正确 optionId', async () => {
    const p = createPendingPermission('req_1', 1000);
    expect(pendingSize()).toBe(1);
    const ok = resolvePermission('req_1', 'allow_always');
    expect(ok).toBe(true);
    const got = await p;
    expect(got).toBe('allow_always');
    expect(pendingSize()).toBe(0);
  });

  it('超时 → reject("permission timeout") 且 pending 清理', async () => {
    const p = createPendingPermission('req_to', 10);
    let err: unknown = null;
    try { await p; } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('permission timeout');
    expect(pendingSize()).toBe(0);
  });

  it('cancelAllPending → 所有 pending reject + 清空', async () => {
    const p1 = createPendingPermission('r1', 5000).catch((e) => (e as Error).message);
    const p2 = createPendingPermission('r2', 5000).catch((e) => (e as Error).message);
    expect(pendingSize()).toBe(2);
    cancelAllPending('gone');
    expect(pendingSize()).toBe(0);
    expect(await p1).toBe('gone');
    expect(await p2).toBe('gone');
  });

  it('resolvePermission 不存在的 requestId → false', () => {
    expect(resolvePermission('ghost', 'anything')).toBe(false);
  });

  it('resolve 后再 resolve 同 id → 第二次 false（已清理）', async () => {
    const p = createPendingPermission('r_dup', 1000);
    expect(resolvePermission('r_dup', 'allow')).toBe(true);
    expect(resolvePermission('r_dup', 'allow')).toBe(false);
    await p;
  });

  it('handlePermissionResponse → 调 resolve + ack.ok=true', async () => {
    const p = createPendingPermission('r_h', 1000);
    const ws = fakeWs();
    handlePermissionResponse(ws, { op: 'permission_response', requestId: 'r_h', optionId: 'allow' });
    expect(last(ws)).toEqual({ type: 'ack', requestId: '', ok: true });
    expect(await p).toBe('allow');
  });

  it('handlePermissionResponse 对不存在的 requestId 也 ack（幂等）', () => {
    const ws = fakeWs();
    handlePermissionResponse(ws, { op: 'permission_response', requestId: 'ghost', optionId: 'x' });
    expect(last(ws)).toEqual({ type: 'ack', requestId: '', ok: true });
  });
});
