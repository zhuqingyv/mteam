// EventBus —— 后端全局事件总线。取代旧 roleEvents EventEmitter。
// emit 同步分发（RxJS Subject.next 语义），subscriber 抛错在这里被 try-catch 吞掉，
// 不会沿调用栈冒泡到 emit 调用方（保证 handler 不会因下游 subscriber 挂掉而 500）。
// 全局单例 `bus` 给生产用；测试场景用 `new EventBus()` 隔离，避免跨 test 串扰。
import { Subject, type Observable } from 'rxjs';
import { filter, share } from 'rxjs/operators';
import type { BusEvent } from './types.js';

export type {
  BusEvent,
  BusEventType,
  BusEventBase,
  InstanceCreatedEvent,
  InstanceActivatedEvent,
  InstanceOfflineRequestedEvent,
  InstanceDeletedEvent,
  InstanceSessionRegisteredEvent,
  PtySpawnedEvent,
  PtyExitedEvent,
  CommRegisteredEvent,
  CommDisconnectedEvent,
  CommMessageSentEvent,
  CommMessageReceivedEvent,
  TemplateCreatedEvent,
  TemplateUpdatedEvent,
  TemplateDeletedEvent,
  McpInstalledEvent,
  McpUninstalledEvent,
  TeamCreatedEvent,
  TeamDisbandedEvent,
  TeamMemberJoinedEvent,
  TeamMemberLeftEvent,
  CliAvailableEvent,
  CliUnavailableEvent,
  PrimaryAgentStartedEvent,
  PrimaryAgentStoppedEvent,
  PrimaryAgentConfiguredEvent,
  DriverStartedEvent,
  DriverStoppedEvent,
  DriverErrorEvent,
  DriverThinkingEvent,
  DriverTextEvent,
  DriverToolCallEvent,
  DriverToolResultEvent,
  DriverTurnDoneEvent,
} from './types.js';

export class EventBus {
  private readonly subject = new Subject<BusEvent>();
  readonly events$: Observable<BusEvent> = this.subject.asObservable().pipe(share());

  emit(event: BusEvent): void {
    try {
      this.subject.next(event);
    } catch (err) {
      process.stderr.write(
        `[bus] FATAL: subscriber threw while dispatching ${event.type}: ${(err as Error).message}\n`,
      );
    }
  }

  on<T extends BusEvent['type']>(
    type: T,
  ): Observable<Extract<BusEvent, { type: T }>> {
    return this.events$.pipe(
      filter((e): e is Extract<BusEvent, { type: T }> => e.type === type),
    );
  }

  onPrefix(prefix: string): Observable<BusEvent> {
    return this.events$.pipe(filter((e) => e.type.startsWith(prefix)));
  }

  destroy(): void {
    this.subject.complete();
  }
}

export const bus = new EventBus();
