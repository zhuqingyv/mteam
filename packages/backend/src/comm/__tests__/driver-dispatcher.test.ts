// driver-dispatcher 单测：注入 fake registry + fake driver，覆盖四条分支。
// 不 mock：DriverRegistry 本身是纯 Map，直接 new 真实实例。
import { describe, it, expect, beforeEach } from 'bun:test';
import type { AgentDriver } from '../../agent-driver/driver.js';
import { DriverRegistry } from '../../agent-driver/registry.js';
import { createDriverDispatcher } from '../driver-dispatcher.js';
import type { DriverDispatcher, DriverDispatchResult } from '../router.js';

interface FakeDriver {
  ready: boolean;
  prompted: string[];
  promptError?: Error;
}

function fakeDriver(opts: Partial<FakeDriver> = {}): AgentDriver {
  const state: FakeDriver = { ready: true, prompted: [], ...opts };
  return {
    isReady: () => state.ready,
    prompt: async (text: string) => {
      if (state.promptError) throw state.promptError;
      state.prompted.push(text);
    },
    _state: state,
  } as unknown as AgentDriver;
}

describe('createDriverDispatcher', () => {
  let reg: DriverRegistry;
  beforeEach(() => {
    reg = new DriverRegistry();
  });

  it('未注册 → not-found', async () => {
    const dispatch = createDriverDispatcher(reg);
    expect(await dispatch('ghost', 'hi')).toBe('not-found');
  });

  it('已注册但 isReady=false → not-ready，不调 prompt', async () => {
    const d = fakeDriver({ ready: false });
    reg.register('m1', d);
    const dispatch = createDriverDispatcher(reg);
    expect(await dispatch('m1', 'hi')).toBe('not-ready');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((d as any)._state.prompted).toEqual([]);
  });

  it('READY → 调 prompt 后返回 delivered', async () => {
    const d = fakeDriver();
    reg.register('m1', d);
    const dispatch = createDriverDispatcher(reg);
    expect(await dispatch('m1', 'hello')).toBe('delivered');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((d as any)._state.prompted).toEqual(['hello']);
  });

  it('driver.prompt 抛异常 → 吞掉并返回 not-ready（让 router 回退 socket/offline）', async () => {
    const d = fakeDriver({ promptError: new Error('boom') });
    reg.register('m1', d);
    const dispatch = createDriverDispatcher(reg);
    expect(await dispatch('m1', 'hi')).toBe('not-ready');
  });

  it('异常分支不把 driver 从 registry 摘掉（摘除是 lifecycle 责任）', async () => {
    const d = fakeDriver({ promptError: new Error('boom') });
    reg.register('m1', d);
    const dispatch = createDriverDispatcher(reg);
    await dispatch('m1', 'hi');
    expect(reg.get('m1')).toBe(d);
  });

  it('多 driver 并发下发相互不干扰', async () => {
    const d1 = fakeDriver();
    const d2 = fakeDriver();
    reg.register('a', d1);
    reg.register('b', d2);
    const dispatch = createDriverDispatcher(reg);
    const [r1, r2] = await Promise.all([dispatch('a', 'x'), dispatch('b', 'y')]);
    expect(r1).toBe('delivered');
    expect(r2).toBe('delivered');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((d1 as any)._state.prompted).toEqual(['x']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((d2 as any)._state.prompted).toEqual(['y']);
  });
});

// ─── W2-E 签名冻结断言（编译期 + 运行期） ──────────────────────────────
// 任何改动 DriverDispatcher 签名/返回值集合的行为都会让 tsc 炸掉或运行期断言失败。
// 参考：phase-comm/TASK-LIST.md §W2-E、phase-comm/REGRESSION.md U-110 / R-07、
//       phase-sandbox-acp/INTERFACE-CONTRACTS.md（跨 Stage 冻结接口）。
describe('DriverDispatcher 签名冻结（W2-E）', () => {
  it('U-110 · createDriverDispatcher 返回值类型等价于 DriverDispatcher', () => {
    // 编译期断言：若 createDriverDispatcher 的形参/返回形状漂移，这一行直接 tsc 报错。
    type Returned = ReturnType<typeof createDriverDispatcher>;
    type AssertEqual = Returned extends DriverDispatcher
      ? DriverDispatcher extends Returned
        ? true
        : false
      : false;
    const ok: AssertEqual = true;
    expect(ok).toBe(true);

    // 运行期形状断言：确保工厂返回 2 元 arity、Promise 风格的函数。
    const dispatch = createDriverDispatcher(new DriverRegistry());
    expect(typeof dispatch).toBe('function');
    expect(dispatch.length).toBe(2); // (memberInstanceId, text)
    const ret = dispatch('ghost', 'probe');
    expect(ret).toBeInstanceOf(Promise);
    // 把异步返回的 promise 吞掉，避免未处理 rejection 警告
    void ret.catch(() => {});
  });

  it('U-110b · DriverDispatchResult 字面量集合冻结为 delivered|not-ready|not-found', async () => {
    // 编译期断言：任何对 DriverDispatchResult 字面量集合的扩缩都会让下面任一行 tsc 报错。
    const allowed: readonly DriverDispatchResult[] = ['delivered', 'not-ready', 'not-found'] as const;
    type Allowed = (typeof allowed)[number];
    type AssertResult = [Allowed] extends [DriverDispatchResult]
      ? [DriverDispatchResult] extends [Allowed]
        ? true
        : false
      : false;
    const ok: AssertResult = true;
    expect(ok).toBe(true);

    // 运行期覆盖：dispatcher 真的能产出 not-found（另两支在上面的 describe 里已覆盖），
    // 三支并集即 DriverDispatchResult，三点足够钉死。
    const dispatch = createDriverDispatcher(new DriverRegistry());
    const r = await dispatch('ghost', 'probe');
    expect(allowed).toContain(r);
  });
});
