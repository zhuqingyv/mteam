// W2-5 · 通知代理模式路由。纯函数（给定 event + userId → 目标）。
// 契约：docs/phase-ws/TASK-LIST.md §W2-5。
// 三种 mode：
//   - proxy_all → primary agent；primary 不在线 fallback direct（记 warn）
//   - direct    → user:<userId ?? 'local'>
//   - custom    → 自顶向下首命中 rule.to；全不命中 → drop
// 不做事件白名单检查，由调用方（notification.subscriber）在本模块前用
// isNotifiableEventType() 守门；这里收到的事件默认已属于可通知集合。

import type { BusEvent } from '../bus/types.js';
import { matchRule, type NotificationStore } from './types.js';

export type ProxyTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; instanceId: string }
  | { kind: 'primary_agent' }
  | { kind: 'drop' };

export interface ProxyRouter {
  route(event: BusEvent, userId: string | null): ProxyTarget;
}

export interface ProxyRouterDeps {
  store: NotificationStore;
  /**
   * 返回当前 primary agent 的 instanceId；无 primary → null。
   * 用于 proxy_all 模式 fallback：primary 缺席时退回 direct。
   * 订阅层从 roster / primary-agent 管理器拿，router 不反向依赖业务层。
   */
  getPrimaryAgentInstanceId(): string | null;
  /** warn 钩子；默认 console.warn。测试注入以便断言调用次数。 */
  warn?: (msg: string) => void;
}

const FALLBACK_USER_ID = 'local';

function userTarget(userId: string | null): ProxyTarget {
  return { kind: 'user', userId: userId ?? FALLBACK_USER_ID };
}

export function createProxyRouter(deps: ProxyRouterDeps): ProxyRouter {
  const warn = deps.warn ?? ((msg: string) => console.warn(msg));

  return {
    route(event, userId) {
      const cfg = deps.store.get(userId);

      if (cfg.mode === 'proxy_all') {
        if (deps.getPrimaryAgentInstanceId() == null) {
          warn(
            `[notification/proxy-router] proxy_all fallback direct: ` +
              `primary agent offline (event=${event.type}, userId=${userId ?? 'null'})`,
          );
          return userTarget(userId);
        }
        return { kind: 'primary_agent' };
      }

      if (cfg.mode === 'direct') {
        return userTarget(userId);
      }

      // mode === 'custom'
      for (const rule of cfg.rules ?? []) {
        if (matchRule(rule, event.type)) {
          return rule.to;
        }
      }
      return { kind: 'drop' };
    },
  };
}
