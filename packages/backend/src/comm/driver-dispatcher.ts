// driver-dispatcher —— CommRouter 与 DriverRegistry 之间的胶水。
// 业务模块：同时 import agent-driver/registry 与 comm/router 的 DriverDispatcher 类型。
// Router 本身仍不反向 import agent-driver。
import type { DriverRegistry } from '../agent-driver/registry.js';
import type { DriverDispatcher } from './router.js';

export function createDriverDispatcher(registry: DriverRegistry): DriverDispatcher {
  return async (memberInstanceId, text) => {
    const driver = registry.get(memberInstanceId);
    if (!driver) return 'not-found';
    if (!driver.isReady()) return 'not-ready';
    try {
      await driver.prompt(text);
      return 'delivered';
    } catch {
      return 'not-ready';
    }
  };
}
