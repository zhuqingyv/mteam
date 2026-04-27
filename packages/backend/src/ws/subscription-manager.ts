// Phase WS · W1-B：per-connection 订阅状态管理。
// 纯数据结构 + 纯函数 match，不 import bus / db / comm 的运行时代码。
// 越权校验（user scope id !== ctx.userId）不在本模块做，由 ws-handler 在 subscribe 前挡掉。

import type { BusEvent } from '../bus/types.js';
import type { SubscriptionScope } from './protocol.js';

export interface ClientSubscription {
  scope: SubscriptionScope;
  /** global 时固定为 null；team/instance/user 时为目标 id。 */
  id: string | null;
}

export interface ConnectionRecord {
  readonly connectionId: string;
  /** 序列化形如 "team:team_01" / "global:" / "user:u1" / "instance:inst_1"。 */
  readonly subs: Set<string>;
}

/**
 * 把订阅规范化成 Set key。
 * global 的 id 一律忽略为空串（调用方即使传了也不生效，文档里写明）。
 */
function keyOf(sub: ClientSubscription): string {
  if (sub.scope === 'global') return 'global:';
  return `${sub.scope}:${sub.id ?? ''}`;
}

/** "team:t1" → { scope:'team', id:'t1' }；解析自身写入的 key，不对外暴露。 */
function parseKey(key: string): ClientSubscription {
  const idx = key.indexOf(':');
  const scope = key.slice(0, idx) as SubscriptionScope;
  const rest = key.slice(idx + 1);
  return { scope, id: scope === 'global' ? null : rest };
}

/** 从 BusEvent 里把 "实例身份" 抽出来，命中 instance:<id> 订阅用。 */
function extractInstanceId(event: BusEvent): string | null {
  if ('instanceId' in event && typeof event.instanceId === 'string') return event.instanceId;
  if ('driverId' in event && typeof event.driverId === 'string') return event.driverId;
  return null;
}

function extractTeamId(event: BusEvent): string | null {
  if ('teamId' in event && typeof event.teamId === 'string') return event.teamId;
  return null;
}

/**
 * comm.* 事件的 envelope.to 形如 'user:u1' / 'local:<instanceId>' / 'local:system'。
 * 命中 user:<id> 订阅时用它。from 不参与用户订阅匹配 —— 设计意图是"收到给我的消息"，
 * 不是"我发出去的消息也回显"（回显由前端本地已发送列表拼，避免重复）。
 */
function extractUserIdFromCommTo(event: BusEvent): string | null {
  if (event.type !== 'comm.message_sent' && event.type !== 'comm.message_received') return null;
  const to = event.to;
  if (typeof to !== 'string') return null;
  if (!to.startsWith('user:')) return null;
  return to.slice('user:'.length);
}

export class SubscriptionManager {
  private readonly conns = new Map<string, ConnectionRecord>();

  /** 初始化空记录；重复 addConn 同一 id 幂等，不覆盖既有订阅。 */
  addConn(connectionId: string): void {
    if (this.conns.has(connectionId)) return;
    this.conns.set(connectionId, { connectionId, subs: new Set<string>() });
  }

  /** 断开时调用；返回 true 表示确实移除过。 */
  removeConn(connectionId: string): boolean {
    return this.conns.delete(connectionId);
  }

  subscribe(connectionId: string, sub: ClientSubscription): void {
    const rec = this.conns.get(connectionId);
    if (!rec) return;
    rec.subs.add(keyOf(sub));
  }

  unsubscribe(connectionId: string, sub: ClientSubscription): void {
    const rec = this.conns.get(connectionId);
    if (!rec) return;
    rec.subs.delete(keyOf(sub));
  }

  /**
   * 判断某个事件是否命中连接的订阅集合。
   * 规则按优先级短路：
   *   1. 订阅 'global:' → 任何事件命中
   *   2. event 带 instanceId/driverId 且订阅 'instance:<id>' → 命中
   *   3. event 带 teamId 且订阅 'team:<id>' → 命中
   *   4. event 是 comm.* 且 envelope.to = 'user:<id>' 且订阅 'user:<id>' → 命中
   *   5. 其他 → drop
   * 纯函数，不查 bus/db；未 addConn 的连接永远不命中。
   */
  match(connectionId: string, event: BusEvent): boolean {
    const rec = this.conns.get(connectionId);
    if (!rec || rec.subs.size === 0) return false;
    if (rec.subs.has('global:')) return true;

    const instanceId = extractInstanceId(event);
    if (instanceId !== null && rec.subs.has(`instance:${instanceId}`)) return true;

    const teamId = extractTeamId(event);
    if (teamId !== null && rec.subs.has(`team:${teamId}`)) return true;

    const userId = extractUserIdFromCommTo(event);
    if (userId !== null && rec.subs.has(`user:${userId}`)) return true;

    return false;
  }

  /** 调试/测试用。返回拷贝防止外部改动内部 Set。 */
  list(connectionId: string): ClientSubscription[] {
    const rec = this.conns.get(connectionId);
    if (!rec) return [];
    return Array.from(rec.subs, parseKey);
  }

  stats(): { conns: number; totalSubs: number } {
    let total = 0;
    for (const rec of this.conns.values()) total += rec.subs.size;
    return { conns: this.conns.size, totalSubs: total };
  }
}
