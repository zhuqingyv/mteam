// Log subscriber —— bus 事件审计日志。
// 默认完全静默，设 TEAM_HUB_LOG_BUS=1 才启用；启用后高频 chunk 类事件不落 stderr。
// 强制输出：driver.error / runtime.fatal —— 生产排查必须保留。
// Why: 流式 chunk（driver.text/thinking/turn.block_updated/driver.tool_update）极高频，
// 全量 JSON.stringify + stderr write 会拖慢整条 bus 分发链，详见性能审查 knowledge:652。
import { Subscription } from 'rxjs';
import { EventBus, bus } from '../events.js';
import type { BusEvent, BusEventType } from '../types.js';

// 默认屏蔽的高频事件（仅当 TEAM_HUB_LOG_BUS=1 时才会被考虑输出）。
const HIGH_FREQ_BLACKLIST: ReadonlySet<BusEventType> = new Set<BusEventType>([
  'driver.text',
  'driver.thinking',
  'turn.block_updated',
  'driver.tool_update',
]);

// 无论开关如何都必须输出的事件：生产故障排查的最后一道保障。
const ALWAYS_LOG: ReadonlySet<BusEventType> = new Set<BusEventType>([
  'driver.error',
  'runtime.fatal',
]);

function shouldLog(event: BusEvent, enabled: boolean): boolean {
  if (ALWAYS_LOG.has(event.type)) return true;
  if (!enabled) return false;
  return !HIGH_FREQ_BLACKLIST.has(event.type);
}

export function subscribeLog(eventBus: EventBus = bus): Subscription {
  const sub = new Subscription();
  const enabled = process.env.TEAM_HUB_LOG_BUS === '1';

  sub.add(
    eventBus.events$.subscribe((e) => {
      if (!shouldLog(e, enabled)) return;
      try {
        process.stderr.write(`[bus] ${e.type} ${JSON.stringify(e)}\n`);
      } catch (err) {
        process.stderr.write(
          `[bus] log write failed for ${e.type}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  return sub;
}
