// W2-3 self-heal helper 单测：工厂独立性 + schedule/cancel + reset 语义。
import { describe, it, expect } from 'bun:test';
import { createSelfHeal } from './self-heal.js';

describe('createSelfHeal', () => {
  it('默认 config：1s/2s/4s 指数退避，第 4 次 give_up', () => {
    const sh = createSelfHeal();
    expect(sh.onCrash('x')).toEqual({ action: 'restart', delayMs: 1000, attempt: 1 });
    expect(sh.onCrash('x')).toEqual({ action: 'restart', delayMs: 2000, attempt: 2 });
    expect(sh.onCrash('x')).toEqual({ action: 'restart', delayMs: 4000, attempt: 3 });
    expect(sh.onCrash('x')).toEqual({ action: 'give_up', delayMs: 0, attempt: 4 });
  });

  it('schedule 延时触发 run；cancelScheduled 覆盖挂起的 timer', async () => {
    const sh = createSelfHeal();
    let count = 0;
    sh.schedule(10, () => { count += 1; });
    sh.cancelScheduled();
    await new Promise((r) => setTimeout(r, 30));
    expect(count).toBe(0);

    sh.schedule(5, () => { count += 1; });
    await new Promise((r) => setTimeout(r, 30));
    expect(count).toBe(1);
  });

  it('连续 schedule：旧的被自动 cancel，只跑最新的', async () => {
    const sh = createSelfHeal();
    const calls: number[] = [];
    sh.schedule(50, () => calls.push(1));
    sh.schedule(10, () => calls.push(2));
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toEqual([2]);
  });

  it('reset 清零计数 + 取消挂起 schedule', async () => {
    const sh = createSelfHeal();
    sh.onCrash('a');
    sh.onCrash('a');
    let fired = 0;
    sh.schedule(20, () => { fired += 1; });
    sh.reset('a');
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBe(0);
    expect(sh.onCrash('a')).toEqual({ action: 'restart', delayMs: 1000, attempt: 1 });
  });

  it('两个独立 SelfHeal 实例计数不共享（S4 物理隔离）', () => {
    const a = createSelfHeal({ maxRestarts: 3, backoffBaseMs: 1000 });
    const b = createSelfHeal({ maxRestarts: 3, backoffBaseMs: 1000 });
    for (let i = 0; i < 3; i++) a.onCrash('agent-1');
    expect(a.onCrash('agent-1').action).toBe('give_up');
    // 同样的 agentId，b 的计数不受 a 影响
    expect(b.onCrash('agent-1').action).toBe('restart');
    expect(b.onCrash('agent-1').attempt).toBe(2);
  });

  it('自定义 maxRestarts=0：第一次就 give_up', () => {
    const sh = createSelfHeal({ maxRestarts: 0, backoffBaseMs: 100 });
    expect(sh.onCrash('x')).toEqual({ action: 'give_up', delayMs: 0, attempt: 1 });
  });
});
