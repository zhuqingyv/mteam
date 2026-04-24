// 驱动层 DriverEvent → bus BusEvent 的翻译桥。
// 保持 driver.ts 只关心生命周期和 ACP IO，事件翻译集中在这里。
import { bus } from '../bus/events.js';
import { makeBase } from '../bus/helpers.js';
import type { DriverEvent } from './types.js';

const SOURCE = 'agent-driver';

// 驱动层广播的全部事件（包括只 driver.ts 自己会发的生命周期事件）。
export type DriverBusEvent =
  | DriverEvent
  | { type: 'driver.started' }
  | { type: 'driver.stopped' }
  | { type: 'driver.error'; message: string };

export function emitToBus(driverId: string, ev: DriverBusEvent): void {
  switch (ev.type) {
    case 'driver.started':
      bus.emit({ ...makeBase('driver.started', SOURCE), driverId });
      return;
    case 'driver.stopped':
      bus.emit({ ...makeBase('driver.stopped', SOURCE), driverId });
      return;
    case 'driver.error':
      bus.emit({ ...makeBase('driver.error', SOURCE), driverId, message: ev.message });
      return;
    case 'driver.thinking':
      bus.emit({ ...makeBase('driver.thinking', SOURCE), driverId, content: ev.content });
      return;
    case 'driver.text':
      bus.emit({ ...makeBase('driver.text', SOURCE), driverId, content: ev.content });
      return;
    case 'driver.tool_call':
      bus.emit({
        ...makeBase('driver.tool_call', SOURCE),
        driverId,
        name: ev.name,
        input: toRecord(ev.input),
      });
      return;
    case 'driver.tool_result':
      bus.emit({ ...makeBase('driver.tool_result', SOURCE), driverId });
      return;
    case 'driver.turn_done':
      bus.emit({ ...makeBase('driver.turn_done', SOURCE), driverId });
      return;
  }
}

function toRecord(x: unknown): Record<string, unknown> {
  if (x && typeof x === 'object' && !Array.isArray(x)) return x as Record<string, unknown>;
  return {};
}
