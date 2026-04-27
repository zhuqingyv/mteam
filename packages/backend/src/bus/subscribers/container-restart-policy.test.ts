// M4 · container-restart-policy 单测（跟随 M8 落地的最小版本）。
// 公式：delay = backoffBaseMs * 2^(attempt-1)；attempt>maxRestarts → give_up。
import { describe, it, expect } from 'bun:test';
import { createRestartPolicy } from './container-restart-policy.js';

describe('container-restart-policy', () => {
  it('第 1/2/3 次崩溃：attempt + delay 正确（指数退避）', () => {
    const p = createRestartPolicy();
    expect(p.onCrash('a')).toEqual({ action: 'restart', delayMs: 1000, attempt: 1 });
    expect(p.onCrash('a')).toEqual({ action: 'restart', delayMs: 2000, attempt: 2 });
    expect(p.onCrash('a')).toEqual({ action: 'restart', delayMs: 4000, attempt: 3 });
  });

  it('第 4 次崩溃：give_up，delayMs=0', () => {
    const p = createRestartPolicy();
    for (let i = 0; i < 3; i++) p.onCrash('a');
    expect(p.onCrash('a')).toEqual({ action: 'give_up', delayMs: 0, attempt: 4 });
  });

  it('reset 后计数清零，重新从 1 起算', () => {
    const p = createRestartPolicy();
    p.onCrash('a');
    p.onCrash('a');
    p.reset('a');
    expect(p.peek('a')).toBe(0);
    expect(p.onCrash('a')).toEqual({ action: 'restart', delayMs: 1000, attempt: 1 });
  });

  it('maxRestarts=0：第一次就 give_up（边界）', () => {
    const p = createRestartPolicy({ maxRestarts: 0 });
    expect(p.onCrash('a')).toEqual({ action: 'give_up', delayMs: 0, attempt: 1 });
  });

  it('不同 agentId 计数互相隔离', () => {
    const p = createRestartPolicy();
    p.onCrash('a');
    p.onCrash('a');
    p.onCrash('b');
    expect(p.peek('a')).toBe(2);
    expect(p.peek('b')).toBe(1);
  });

  it('peek 返回当前次数，不触发 onCrash 副作用', () => {
    const p = createRestartPolicy();
    expect(p.peek('a')).toBe(0);
    p.onCrash('a');
    expect(p.peek('a')).toBe(1);
    expect(p.peek('a')).toBe(1);
  });

  it('自定义 backoffBaseMs：delay 按新基数计算', () => {
    const p = createRestartPolicy({ backoffBaseMs: 500, maxRestarts: 5 });
    expect(p.onCrash('a').delayMs).toBe(500);
    expect(p.onCrash('a').delayMs).toBe(1000);
    expect(p.onCrash('a').delayMs).toBe(2000);
  });
});
