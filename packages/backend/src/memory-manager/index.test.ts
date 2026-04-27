// 单例 import 副作用验证 —— W1-6 判据：import 不起 ticker / 不泄漏定时器。
import { describe, it, expect } from 'bun:test';

describe('memory-manager index', () => {
  it('import 不触发 ticker（lazy 起）', async () => {
    const activeBefore = (process as unknown as { _getActiveHandles?: () => unknown[] })
      ._getActiveHandles?.().length ?? 0;
    const mod = await import('./index.js');
    const activeAfter = (process as unknown as { _getActiveHandles?: () => unknown[] })
      ._getActiveHandles?.().length ?? 0;
    expect(activeAfter - activeBefore).toBe(0);
    expect(mod.memoryManager).toBeDefined();
    expect(mod.MemoryManager).toBeDefined();
    expect(mod.mapAsCollection).toBeDefined();
    expect(mod.setAsCollection).toBeDefined();
  });
});
