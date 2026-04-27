// Phase WS · W2-3 user-session 测试。
// 真 CommRegistry + 假 ws（最小 WsLike 实现），覆盖 TASK-LIST 三条完成判据。
// 不 mock db / bus：UserSessionTracker 不触及它们。

import { describe, it, expect } from 'bun:test';
import { CommRegistry } from '../comm/registry.js';
import type { WsLike } from '../comm/socket-shims.js';
import { UserSessionTracker } from './user-session.js';

// ---------- 最小假 WS ----------

class FakeWs implements WsLike {
  readyState = 1; // OPEN
  sent: string[] = [];
  closed = false;
  private closeHandlers: Array<() => void> = [];
  private errorHandlers: Array<() => void> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3; // CLOSED
    for (const h of this.closeHandlers) h();
  }

  addEventListener(type: 'close' | 'error', listener: () => void): void {
    if (type === 'close') this.closeHandlers.push(listener);
    else this.errorHandlers.push(listener);
  }

  /** 触发外部 close（模拟客户端断开）。 */
  simulateRemoteClose(): void {
    this.close();
  }

  /** 触发 error 事件。 */
  simulateError(): void {
    for (const h of this.errorHandlers) h();
  }
}

// ---------- 用例 ----------

describe('UserSessionTracker', () => {
  it('register 后 commRegistry 能 getConnection(user:<userId>)', () => {
    const registry = new CommRegistry();
    const tracker = new UserSessionTracker({ commRegistry: registry });
    const ws = new FakeWs();

    tracker.register('conn_1', 'u1', ws);

    const conn = registry.getConnection('user:u1');
    expect(conn).not.toBeNull();
    expect(conn!.destroyed).toBe(false);
    expect(tracker.listActive()).toEqual([{ connectionId: 'conn_1', userId: 'u1' }]);
  });

  it('通过 registry.getConnection(...).write 会转发到 ws.send', () => {
    const registry = new CommRegistry();
    const tracker = new UserSessionTracker({ commRegistry: registry });
    const ws = new FakeWs();
    tracker.register('conn_1', 'u1', ws);

    const conn = registry.getConnection('user:u1')!;
    const ok = conn.write('hello\n');

    expect(ok).toBe(true);
    expect(ws.sent).toEqual(['hello\n']);
  });

  it('unregister 后 registry 看不到该 user + listActive 变空', () => {
    const registry = new CommRegistry();
    const tracker = new UserSessionTracker({ commRegistry: registry });
    const ws = new FakeWs();

    tracker.register('conn_1', 'u1', ws);
    tracker.unregister('conn_1');

    expect(registry.getConnection('user:u1')).toBeNull();
    expect(tracker.listActive()).toEqual([]);
  });

  it('unregister 未注册的 connectionId 是 no-op', () => {
    const registry = new CommRegistry();
    const tracker = new UserSessionTracker({ commRegistry: registry });

    expect(() => tracker.unregister('ghost')).not.toThrow();
    expect(tracker.listActive()).toEqual([]);
  });

  it('多 tab：后注册覆盖前者，前者 shim.destroyed=true', () => {
    const registry = new CommRegistry();
    const tracker = new UserSessionTracker({ commRegistry: registry });
    const wsA = new FakeWs();
    const wsB = new FakeWs();

    tracker.register('conn_A', 'u1', wsA);
    const firstShim = registry.getConnection('user:u1')!;

    tracker.register('conn_B', 'u1', wsB);
    const secondShim = registry.getConnection('user:u1')!;

    // registry 上已是 B 的 shim
    expect(secondShim).not.toBe(firstShim);
    // registry.register 内部会 destroy 前任；前任 shim 因此 destroyed=true 且 wsA 被 close
    expect(firstShim.destroyed).toBe(true);
    expect(wsA.closed).toBe(true);
    // B 仍活着
    expect(secondShim.destroyed).toBe(false);
  });

  it('多 tab：新旧 connectionId 都在 byConn 里；unregister 旧连接不影响新连接', () => {
    const registry = new CommRegistry();
    const tracker = new UserSessionTracker({ commRegistry: registry });
    const wsA = new FakeWs();
    const wsB = new FakeWs();

    tracker.register('conn_A', 'u1', wsA);
    tracker.register('conn_B', 'u1', wsB);

    // 旧连接 close → 新连接不受影响
    tracker.unregister('conn_A');

    const live = registry.getConnection('user:u1');
    expect(live).not.toBeNull();
    const ok = live!.write('still alive');
    expect(ok).toBe(true);
    expect(wsB.sent).toEqual(['still alive']);

    expect(tracker.listActive()).toEqual([{ connectionId: 'conn_B', userId: 'u1' }]);
  });

  it('ws remote close 后 shim.destroyed=true（写失败走 offline）', () => {
    const registry = new CommRegistry();
    const tracker = new UserSessionTracker({ commRegistry: registry });
    const ws = new FakeWs();
    tracker.register('conn_1', 'u1', ws);

    const shim = registry.getConnection('user:u1')!;
    ws.simulateRemoteClose();

    expect(shim.destroyed).toBe(true);
    // 模拟 router 在不知道 close 的情况下尝试 write — 写失败 + 不抛
    expect(shim.write('late')).toBe(false);
  });

  it('ws.send 抛异常 → write 返回 false 并置 destroyed', () => {
    const registry = new CommRegistry();
    const tracker = new UserSessionTracker({ commRegistry: registry });
    const ws = new FakeWs();
    ws.send = () => {
      throw new Error('broken pipe');
    };
    tracker.register('conn_1', 'u1', ws);

    const shim = registry.getConnection('user:u1')!;
    expect(shim.write('boom')).toBe(false);
    expect(shim.destroyed).toBe(true);
  });

  it('register 同 connectionId 重复调用：先 unregister 再注册，不泄漏', () => {
    const registry = new CommRegistry();
    const tracker = new UserSessionTracker({ commRegistry: registry });
    const ws1 = new FakeWs();
    const ws2 = new FakeWs();

    tracker.register('conn_1', 'u1', ws1);
    tracker.register('conn_1', 'u1', ws2);

    // 只剩一条活动记录
    expect(tracker.listActive()).toEqual([{ connectionId: 'conn_1', userId: 'u1' }]);
    // ws1 被 close
    expect(ws1.closed).toBe(true);
    // registry 指向 ws2 的 shim
    const conn = registry.getConnection('user:u1')!;
    conn.write('x');
    expect(ws2.sent).toEqual(['x']);
  });
});
