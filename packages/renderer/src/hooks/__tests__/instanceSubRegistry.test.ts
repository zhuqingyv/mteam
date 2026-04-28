// instanceSubRegistry 纯 module-level 逻辑单测。
//
// useSubscribedInstanceIds 是 React hook，走 useSyncExternalStore，这里只直测：
// - add/remove 的幂等与通知
// - extras 快照引用稳定性（同版本返回同引用）

import { afterEach, describe, expect, test } from 'bun:test';
import {
  addInstanceSub,
  removeInstanceSub,
  _resetInstanceSubRegistryForTest,
  _getExtraIdsForTest,
} from '../instanceSubRegistry';

afterEach(() => {
  _resetInstanceSubRegistryForTest();
});

describe('instanceSubRegistry', () => {
  test('addInstanceSub 幂等：同 id 重复加只登记一次', () => {
    addInstanceSub('a');
    addInstanceSub('a');
    addInstanceSub('a');
    expect(_getExtraIdsForTest()).toEqual(['a']);
  });

  test('removeInstanceSub 幂等：不存在的 id 删除无副作用', () => {
    addInstanceSub('a');
    addInstanceSub('b');
    removeInstanceSub('c');
    expect(_getExtraIdsForTest().sort()).toEqual(['a', 'b']);
    removeInstanceSub('a');
    removeInstanceSub('a');
    expect(_getExtraIdsForTest()).toEqual(['b']);
  });

  test('空字符串 id 被忽略', () => {
    addInstanceSub('');
    addInstanceSub('a');
    expect(_getExtraIdsForTest()).toEqual(['a']);
    removeInstanceSub('');
    expect(_getExtraIdsForTest()).toEqual(['a']);
  });

  test('_resetInstanceSubRegistryForTest 清空全部登记', () => {
    addInstanceSub('a');
    addInstanceSub('b');
    _resetInstanceSubRegistryForTest();
    expect(_getExtraIdsForTest()).toEqual([]);
  });
});
