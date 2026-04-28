// S6-M4 useRenderCount：测 bumpCount 纯函数（React hook 部分留给使用方验收）。

import { describe, test, expect } from 'bun:test';
import { bumpCount } from '../useRenderCount';

describe('bumpCount', () => {
  test('每次递增 1 并返回新值', () => {
    const c = { count: 0 };
    expect(bumpCount(c)).toBe(1);
    expect(bumpCount(c)).toBe(2);
    expect(c.count).toBe(2);
  });

  test('log=false 不触发 logger', () => {
    const lines: string[] = [];
    const c = { count: 0, name: 'X' };
    bumpCount(c, false, (s) => lines.push(s));
    expect(lines.length).toBe(0);
  });

  test('log=true 写入 logger，含 name 与次数', () => {
    const lines: string[] = [];
    const c = { count: 0, name: 'MyComp' };
    bumpCount(c, true, (s) => lines.push(s));
    bumpCount(c, true, (s) => lines.push(s));
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('MyComp');
    expect(lines[0]).toContain('#1');
    expect(lines[1]).toContain('#2');
  });

  test('未传 name 时 logger 降级为 anonymous', () => {
    const lines: string[] = [];
    bumpCount({ count: 0 }, true, (s) => lines.push(s));
    expect(lines[0]).toContain('anonymous');
  });
});
