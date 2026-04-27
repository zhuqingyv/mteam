// 驱动层 DriverOutputEvent → bus BusEvent 的订阅式翻译桥。
// 调用方拿到 driver.events$ 后调 attachDriverToBus(driverId, events$)，
// 本模块只负责订阅 + 把事件委派到 translateDriverEvent，不触碰 driver / runtime。
//
// T-8 拆分：翻译 switch 独立到 bus-bridge-translate.ts，本文件保持 ≤ 100 行（team-lead
// 硬约束）。消费方只 import attachDriverToBus 和 DriverOutputEvent 类型；不需要 translate
// 函数本身的请继续走本文件入口。
import type { Observable, Subscription } from 'rxjs';
import { bus as globalBus, type EventBus } from '../bus/events.js';
import type { DriverOutputEvent } from './driver-events.js';
import { translateDriverEvent } from './bus-bridge-translate.js';

export type { DriverOutputEvent };

export function attachDriverToBus(
  driverId: string,
  events$: Observable<DriverOutputEvent>,
  targetBus: EventBus = globalBus,
): Subscription {
  return events$.subscribe((ev) => translateDriverEvent(targetBus, driverId, ev));
}
