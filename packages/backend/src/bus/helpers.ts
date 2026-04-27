// 事件构造辅助：统一 ts / source / correlationId 的生成，避免 emit 点到处复制。
import { randomUUID } from 'node:crypto';
import type { BusEventType } from './types.js';

export function makeBase<T extends BusEventType>(
  type: T,
  source: string,
  correlationId?: string,
): { type: T; ts: string; source: string; correlationId?: string; eventId: string } {
  return {
    type,
    ts: new Date().toISOString(),
    source,
    eventId: randomUUID(),
    ...(correlationId ? { correlationId } : {}),
  };
}

export function newCorrelationId(): string {
  return randomUUID();
}
