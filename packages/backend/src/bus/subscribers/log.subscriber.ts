// Log subscriber —— 全量事件审计日志。
// 订阅 events$（不过滤），每条事件一行写入 stderr。
// 生产环境可改写为落 DB / 推外部日志服务。
import { Subscription } from 'rxjs';
import { EventBus, bus } from '../events.js';

export function subscribeLog(eventBus: EventBus = bus): Subscription {
  const sub = new Subscription();

  sub.add(
    eventBus.events$.subscribe((e) => {
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
