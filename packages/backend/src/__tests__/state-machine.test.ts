// state-machine 纯函数单测：覆盖所有合法转换 + 所有非法转换。
// 这一模块完全不碰 DB，所以不需要 :memory: DB。

import { describe, it, expect } from 'vitest';
import {
  resolveTransition,
  IllegalTransitionError,
  TRANSITIONS,
  type RoleStatus,
  type StateEvent,
} from '../domain/state-machine.js';

describe('state-machine', () => {
  // --- 合法转换 ---
  describe('合法转换', () => {
    it('activate: PENDING -> ACTIVE', () => {
      expect(resolveTransition('activate', 'PENDING')).toBe('ACTIVE');
    });

    it('register_session: PENDING -> ACTIVE', () => {
      // register_session 和 activate 功能对等，都是从 PENDING 变 ACTIVE
      expect(resolveTransition('register_session', 'PENDING')).toBe('ACTIVE');
    });

    it('request_offline: ACTIVE -> PENDING_OFFLINE', () => {
      expect(resolveTransition('request_offline', 'ACTIVE')).toBe('PENDING_OFFLINE');
    });

    it('deactivate: PENDING_OFFLINE -> null (terminal)', () => {
      // 终止态，返回 null 代表物理删除
      expect(resolveTransition('deactivate', 'PENDING_OFFLINE')).toBeNull();
      expect(TRANSITIONS.deactivate.terminal).toBe(true);
    });

    it('crash: PENDING -> null (terminal)', () => {
      expect(resolveTransition('crash', 'PENDING')).toBeNull();
    });

    it('crash: ACTIVE -> null (terminal)', () => {
      expect(resolveTransition('crash', 'ACTIVE')).toBeNull();
    });

    it('crash: PENDING_OFFLINE -> null (terminal)', () => {
      expect(resolveTransition('crash', 'PENDING_OFFLINE')).toBeNull();
      expect(TRANSITIONS.crash.terminal).toBe(true);
    });
  });

  // --- 非法转换：应抛 IllegalTransitionError ---
  describe('非法转换应抛 IllegalTransitionError', () => {
    // 穷举所有 (event, from) 组合，剔除合法的，剩下都应当抛。
    const ALL_EVENTS: StateEvent[] = [
      'activate',
      'register_session',
      'request_offline',
      'deactivate',
      'crash',
    ];
    const ALL_STATES: RoleStatus[] = ['PENDING', 'ACTIVE', 'PENDING_OFFLINE'];

    for (const event of ALL_EVENTS) {
      for (const from of ALL_STATES) {
        if (TRANSITIONS[event].from.includes(from)) continue;
        it(`${event} from ${from} -> 抛 IllegalTransitionError`, () => {
          expect(() => resolveTransition(event, from)).toThrow(IllegalTransitionError);
        });
      }
    }

    it('IllegalTransitionError 携带 from 和 event 字段', () => {
      try {
        // activate 只允许 PENDING，这里用 ACTIVE 触发错误
        resolveTransition('activate', 'ACTIVE');
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(IllegalTransitionError);
        const err = e as IllegalTransitionError;
        expect(err.from).toBe('ACTIVE');
        expect(err.event).toBe('activate');
        expect(err.name).toBe('IllegalTransitionError');
        // 错误消息应包含关键词
        expect(err.message).toContain('activate');
        expect(err.message).toContain('ACTIVE');
      }
    });
  });

  // --- 具体的“任务要求”列出的非法转换 ---
  describe('任务明确指定的非法转换', () => {
    it('PENDING -> PENDING_OFFLINE (通过 request_offline) 应拒绝', () => {
      // request_offline 要求 from=ACTIVE，不能从 PENDING 跳
      expect(() => resolveTransition('request_offline', 'PENDING')).toThrow(
        IllegalTransitionError,
      );
    });

    it('ACTIVE -> PENDING (通过 activate) 应拒绝', () => {
      // 不存在“回到 PENDING”的转换
      expect(() => resolveTransition('activate', 'ACTIVE')).toThrow(
        IllegalTransitionError,
      );
    });

    it('PENDING_OFFLINE -> ACTIVE (通过 activate) 应拒绝', () => {
      expect(() => resolveTransition('activate', 'PENDING_OFFLINE')).toThrow(
        IllegalTransitionError,
      );
    });

    it('PENDING -> 直接 deactivate 应拒绝', () => {
      expect(() => resolveTransition('deactivate', 'PENDING')).toThrow(
        IllegalTransitionError,
      );
    });

    it('ACTIVE -> 直接 deactivate 应拒绝（必须先 request_offline）', () => {
      expect(() => resolveTransition('deactivate', 'ACTIVE')).toThrow(
        IllegalTransitionError,
      );
    });
  });
});
