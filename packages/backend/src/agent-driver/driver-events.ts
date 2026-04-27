// driver 事件流：类型定义 + Subject 封装。
// driver.ts 不直接碰 RxJS；所有事件流细节收敛到这里。
// 外部消费方（bus-bridge / primary-agent）通过 events$ 订阅。
import { Subject, type Observable } from 'rxjs';
import type { DriverEvent } from './types.js';

// driver 自身发的生命周期事件（非 ACP 语义）。
// driver.started 带 pid：Stage 3 W2-1c 把 pid 写回 role_instances.session_pid
// 下沉到 bus 胶水层，由 pid-writeback 订阅此事件完成。pid 取自 RuntimeHandle.pid，
// 透明透传字符串（未来容器化场景用）；本地 host 模式即 child.pid 数字。
export type DriverLifecycleEvent =
  | { type: 'driver.started'; pid?: number | string }
  | { type: 'driver.stopped' }
  | { type: 'driver.error'; message: string };

// driver.events$ 暴露的联合类型 —— ACP 语义事件 + 生命周期事件。
export type DriverOutputEvent = DriverEvent | DriverLifecycleEvent;

// 最小 Subject 封装：emit 推事件，complete 终止流。
// events$ 是 Observable（只读），不暴露 subject 本身。
export class DriverEventEmitter {
  private readonly subject = new Subject<DriverOutputEvent>();
  readonly events$: Observable<DriverOutputEvent> = this.subject.asObservable();

  emit(ev: DriverOutputEvent): void {
    this.subject.next(ev);
  }

  complete(): void {
    this.subject.complete();
  }
}
