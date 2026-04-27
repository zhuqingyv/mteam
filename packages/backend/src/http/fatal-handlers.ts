// Phase Reliability W2-1：全局 process handler。
// - unhandledRejection：stderr 保底 + emit runtime.fatal，不 exit（只记录）。
// - uncaughtException：stderr 保底 + emit runtime.fatal + 触发 shutdown。
// bus 用 getter 注入，因为进程退出路径上 bus 可能已 destroyed；拿到 null 跳过 emit。
// emit 外层再套 try/catch 吞错，防止 subscriber 异常或 completed subject 抛出
// 后重入 uncaughtException 形成递归（M3）。shutdown 同样吞异步 reject。
import type { EventBus } from '../bus/events.js';
import { makeBase } from '../bus/helpers.js';

export interface FatalHandlersDeps {
  getBus: () => EventBus | null;
  shutdown: () => void;
}

export interface FatalHandlersHandle {
  uninstall: () => void;
}

const SOURCE = 'http:fatal-handlers';

function formatError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  try {
    return { message: typeof err === 'string' ? err : JSON.stringify(err) };
  } catch {
    return { message: String(err) };
  }
}

export function installFatalHandlers(deps: FatalHandlersDeps): FatalHandlersHandle {
  const { getBus, shutdown } = deps;

  const report = (kind: 'unhandledRejection' | 'uncaughtException', err: unknown): void => {
    const { message, stack } = formatError(err);
    process.stderr.write(`[fatal] ${kind}: ${message}\n${stack ?? ''}\n`);
    try {
      const bus = getBus();
      if (bus) bus.emit({ ...makeBase('runtime.fatal', SOURCE), kind, message, ...(stack ? { stack } : {}) });
    } catch {
      // swallow: emit 可能因 bus destroyed 或 subscriber 抛错而失败。
      // 此处必须静默，否则会被 uncaughtException 再次捕获形成递归。
    }
  };

  const onRejection = (reason: unknown): void => report('unhandledRejection', reason);
  const onException = (err: unknown): void => {
    report('uncaughtException', err);
    try {
      shutdown();
    } catch {
      // shutdown 抛错同样吞掉，避免递归 uncaughtException。
    }
  };

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  return {
    uninstall: (): void => {
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onException);
    },
  };
}
