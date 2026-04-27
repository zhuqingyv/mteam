// DriverOutputEvent → BusEvent 纯翻译函数。从 bus-bridge.ts 拆出，保证 bus-bridge.ts
// 主文件 ≤ 100 行（team-lead 硬约束）。本文件只做类型翻译，不订阅、不持状态，无副作用
// 除了调 targetBus.emit。
//
// 每个 case 单独 inline 调 makeBase(<字面量>, SOURCE)：不抽工具函数，否则 TS 字面量
// 收窄丢失会导致 emit 的入参被视作 BusEventType 联合，走不进 BusEvent 的 discriminant 分支。
//
// 覆盖范围：phase-ws turn-aggregator 设计 §2.2 的 12 种 DriverEvent + driver 生命周期 3 种
// （started/stopped/error），共 15 case。turn.* 四条由 T-7/T-9 聚合器负责，不在此。
import type { EventBus } from '../bus/events.js';
import { makeBase } from '../bus/helpers.js';
import type { DriverOutputEvent } from './driver-events.js';

const SOURCE = 'agent-driver';

export function translateDriverEvent(
  targetBus: EventBus,
  driverId: string,
  ev: DriverOutputEvent,
): void {
  switch (ev.type) {
    case 'driver.started':
      targetBus.emit({ ...makeBase('driver.started', SOURCE), driverId,
        ...(ev.pid !== undefined ? { pid: ev.pid } : {}) });
      return;
    case 'driver.stopped':
      targetBus.emit({ ...makeBase('driver.stopped', SOURCE), driverId });
      return;
    case 'driver.error':
      targetBus.emit({ ...makeBase('driver.error', SOURCE), driverId, message: ev.message });
      return;
    case 'driver.thinking':
      targetBus.emit({ ...makeBase('driver.thinking', SOURCE), driverId, content: ev.content,
        ...(ev.messageId !== undefined ? { messageId: ev.messageId } : {}) });
      return;
    case 'driver.text':
      targetBus.emit({ ...makeBase('driver.text', SOURCE), driverId, content: ev.content,
        ...(ev.messageId !== undefined ? { messageId: ev.messageId } : {}) });
      return;
    case 'driver.tool_call':
      targetBus.emit({ ...makeBase('driver.tool_call', SOURCE), driverId,
        name: ev.name, input: toRecord(ev.input),
        ...(ev.toolCallId !== undefined ? { toolCallId: ev.toolCallId } : {}),
        ...(ev.title !== undefined ? { title: ev.title } : {}),
        ...(ev.kind !== undefined ? { kind: ev.kind } : {}),
        ...(ev.status !== undefined ? { status: ev.status } : {}),
        ...(ev.locations !== undefined ? { locations: ev.locations } : {}),
        ...(ev.content !== undefined ? { content: ev.content } : {}) });
      return;
    case 'driver.tool_result':
      targetBus.emit({ ...makeBase('driver.tool_result', SOURCE), driverId });
      return;
    case 'driver.tool_update':
      targetBus.emit({ ...makeBase('driver.tool_update', SOURCE), driverId, toolCallId: ev.toolCallId,
        ...(ev.status !== undefined ? { status: ev.status } : {}),
        ...(ev.title !== undefined ? { title: ev.title } : {}),
        ...(ev.kind !== undefined ? { kind: ev.kind } : {}),
        ...(ev.locations !== undefined ? { locations: ev.locations } : {}),
        ...(ev.output !== undefined ? { output: ev.output } : {}),
        ...(ev.content !== undefined ? { content: ev.content } : {}) });
      return;
    case 'driver.plan':
      targetBus.emit({ ...makeBase('driver.plan', SOURCE), driverId, entries: ev.entries });
      return;
    case 'driver.commands':
      targetBus.emit({ ...makeBase('driver.commands', SOURCE), driverId, commands: ev.commands });
      return;
    case 'driver.mode':
      targetBus.emit({ ...makeBase('driver.mode', SOURCE), driverId, currentModeId: ev.currentModeId });
      return;
    case 'driver.config':
      targetBus.emit({ ...makeBase('driver.config', SOURCE), driverId, options: ev.options });
      return;
    case 'driver.session_info':
      targetBus.emit({ ...makeBase('driver.session_info', SOURCE), driverId,
        ...(ev.title !== undefined ? { title: ev.title } : {}),
        ...(ev.updatedAt !== undefined ? { updatedAt: ev.updatedAt } : {}) });
      return;
    case 'driver.usage':
      targetBus.emit({ ...makeBase('driver.usage', SOURCE), driverId, used: ev.used, size: ev.size,
        ...(ev.cost !== undefined ? { cost: ev.cost } : {}) });
      return;
    case 'driver.turn_start':
      targetBus.emit({ ...makeBase('driver.turn_start', SOURCE), driverId,
        turnId: ev.turnId, userInput: ev.userInput });
      return;
    case 'driver.turn_done':
      targetBus.emit({ ...makeBase('driver.turn_done', SOURCE), driverId,
        ...(ev.turnId !== undefined ? { turnId: ev.turnId } : {}),
        ...(ev.stopReason !== undefined ? { stopReason: ev.stopReason } : {}),
        ...(ev.usage !== undefined ? { usage: ev.usage } : {}) });
      return;
  }
}

function toRecord(x: unknown): Record<string, unknown> {
  if (x && typeof x === 'object' && !Array.isArray(x)) return x as Record<string, unknown>;
  return {};
}
