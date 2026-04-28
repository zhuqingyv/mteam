// Phase 4 · server.ts 装配 helper：把 ActionItemScheduler 的依赖线组好。
// notify 通过 CommRouter dispatch system→assignee/creator 的 chat 消息。
import { ActionItemScheduler } from '../action-item/scheduler.js';
import { buildEnvelope } from '../comm/envelope-builder.js';
import type { CommRouter } from '../comm/router.js';
import type { EventBus } from '../bus/events.js';
import type { Ticker } from '../ticker/types.js';

export function createActionItemScheduler(
  ticker: Ticker,
  bus: EventBus,
  router: CommRouter,
): ActionItemScheduler {
  return new ActionItemScheduler(ticker, bus, (to, message) => {
    try {
      const env = buildEnvelope({
        fromKind: 'system',
        fromAddress: 'local:system',
        toAddress: `local:${to}`,
        toLookup: { instanceId: to, memberName: to, displayName: to },
        summary: message,
        content: message,
        kind: 'chat',
      });
      void Promise.resolve(router.dispatch(env)).catch((err: Error) => {
        process.stderr.write(`[action-item] notify dispatch failed: ${err.message}\n`);
      });
    } catch (err) {
      process.stderr.write(
        `[action-item] notify build failed for ${to}: ${(err as Error).message}\n`,
      );
    }
  });
}
