// DriverRegistry —— 进程级 driverId → AgentDriver 映射单例。
// 纯 Map 封装：不 import bus / db / domain，不监听任何事件。
// 注册 / 注销由胶水层（member-driver.subscriber、primary-agent）显式调用。
import type { AgentDriver } from './driver.js';

export class DriverRegistry {
  private readonly map = new Map<string, AgentDriver>();

  register(driverId: string, driver: AgentDriver): void {
    this.map.set(driverId, driver);
  }

  unregister(driverId: string): void {
    this.map.delete(driverId);
  }

  get(driverId: string): AgentDriver | undefined {
    return this.map.get(driverId);
  }

  list(): AgentDriver[] {
    return Array.from(this.map.values());
  }

  clear(): void {
    this.map.clear();
  }
}

export const driverRegistry: DriverRegistry = new DriverRegistry();
