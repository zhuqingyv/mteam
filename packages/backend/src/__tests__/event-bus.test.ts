// EventBus 核心行为单测：emit / on / onPrefix / destroy / 错误隔离。
// 不需要 DB，纯 observable 行为验证。使用 bun:test 自带 runner。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventBus } from '../bus/events.js';
import type { BusEvent } from '../bus/types.js';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.destroy();
  });

  // --- emit + on 基本路由 ---
  describe('emit + on', () => {
    it('on(type) 只收到该 type 的事件，其他事件被 filter 掉', () => {
      const received: BusEvent[] = [];
      const sub = bus.on('instance.created').subscribe((e) => received.push(e));

      bus.emit({
        type: 'instance.created',
        ts: '2026-04-23T00:00:00.000Z',
        source: 'test',
        instanceId: 'i1',
        templateName: 'tpl',
        memberName: 'alice',
        isLeader: false,
        teamId: null,
        task: null,
      });
      bus.emit({
        type: 'instance.activated',
        ts: '2026-04-23T00:00:01.000Z',
        source: 'test',
        instanceId: 'i1',
        actor: null,
      });

      expect(received.length).toBe(1);
      expect(received[0]!.type).toBe('instance.created');
      // 收窄后拿到 instanceId 字段
      if (received[0]!.type === 'instance.created') {
        expect(received[0]!.instanceId).toBe('i1');
      }

      sub.unsubscribe();
    });

    it('多个 subscriber 都能收到同一事件', () => {
      const a: string[] = [];
      const b: string[] = [];
      const s1 = bus.on('instance.created').subscribe((e) => a.push(e.instanceId));
      const s2 = bus.on('instance.created').subscribe((e) => b.push(e.instanceId));

      bus.emit({
        type: 'instance.created',
        ts: 't',
        source: 'test',
        instanceId: 'i1',
        templateName: 'tpl',
        memberName: 'a',
        isLeader: false,
        teamId: null,
        task: null,
      });

      expect(a).toEqual(['i1']);
      expect(b).toEqual(['i1']);
      s1.unsubscribe();
      s2.unsubscribe();
    });
  });

  // --- onPrefix 前缀过滤 ---
  describe('onPrefix', () => {
    it('onPrefix("instance.") 收到所有 instance.* 但不收 driver.*', () => {
      const received: string[] = [];
      const sub = bus.onPrefix('instance.').subscribe((e) => received.push(e.type));

      bus.emit({
        type: 'instance.created',
        ts: 't',
        source: 'test',
        instanceId: 'i1',
        templateName: 'tpl',
        memberName: 'a',
        isLeader: false,
        teamId: null,
        task: null,
      });
      bus.emit({
        type: 'instance.activated',
        ts: 't',
        source: 'test',
        instanceId: 'i1',
        actor: null,
      });
      bus.emit({
        type: 'driver.started',
        ts: 't',
        source: 'test',
        driverId: 'd1',
      });

      expect(received).toEqual(['instance.created', 'instance.activated']);
      sub.unsubscribe();
    });
  });

  // --- destroy: complete 信号 ---
  describe('destroy', () => {
    it('destroy 后 events$ 的 subscriber 收到 complete 信号', () => {
      let completed = false;
      const sub = bus.events$.subscribe({
        complete: () => {
          completed = true;
        },
      });

      bus.destroy();
      expect(completed).toBe(true);
      sub.unsubscribe();
    });

    it('destroy 后再 emit 不会触发任何 subscriber', () => {
      const received: BusEvent[] = [];
      const sub = bus.on('instance.created').subscribe((e) => received.push(e));

      bus.destroy();
      bus.emit({
        type: 'instance.created',
        ts: 't',
        source: 'test',
        instanceId: 'i1',
        templateName: 'tpl',
        memberName: 'a',
        isLeader: false,
        teamId: null,
        task: null,
      });

      expect(received.length).toBe(0);
      sub.unsubscribe();
    });
  });

  // --- 错误隔离：一个 subscriber 抛出不影响后续 ---
  // rxjs Subject.next 默认会把同步抛出的异常沿 next() 向上传给 emit 调用方；
  // EventBus.emit 里用 try/catch 吞掉，所以 emit 不会 crash，其他已订阅的 subscriber 也能继续工作。
  describe('错误隔离', () => {
    it('subscriber 抛异常不会让 emit 抛到调用方', () => {
      const sub = bus.on('instance.created').subscribe(() => {
        throw new Error('boom');
      });
      expect(() =>
        bus.emit({
          type: 'instance.created',
          ts: 't',
          source: 'test',
          instanceId: 'i1',
          templateName: 'tpl',
          memberName: 'a',
          isLeader: false,
          teamId: null,
          task: null,
        }),
      ).not.toThrow();
      sub.unsubscribe();
    });

    it('抛异常后该 subscriber 会被 unsubscribe，但后续 emit 仍通过 bus 工作', () => {
      // rxjs 行为：subscribe 的 next 回调抛出后该 subscription 被 tear down。
      // 这里验证：另一个后订阅的 subscriber 对后续 emit 仍能收到事件，bus 本身不坏。
      const survived: string[] = [];
      const bad = bus.on('instance.created').subscribe(() => {
        throw new Error('boom');
      });
      // 第一次 emit 触发 bad 抛出（被 EventBus 吞）
      bus.emit({
        type: 'instance.created',
        ts: 't',
        source: 'test',
        instanceId: 'i1',
        templateName: 'tpl',
        memberName: 'a',
        isLeader: false,
        teamId: null,
        task: null,
      });

      // 新 subscriber 加入后仍能工作
      const good = bus.on('instance.created').subscribe((e) => survived.push(e.instanceId));
      bus.emit({
        type: 'instance.created',
        ts: 't',
        source: 'test',
        instanceId: 'i2',
        templateName: 'tpl',
        memberName: 'b',
        isLeader: false,
        teamId: null,
        task: null,
      });

      expect(survived).toEqual(['i2']);
      bad.unsubscribe();
      good.unsubscribe();
    });
  });
});
