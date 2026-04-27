// Phase 4 · ActionItemScheduler — 把 ActionItem 的 reminder/timeout 两个时间点映射到 Ticker。
// 接口按 team-lead 指示：boot / onItemCreated / onItemResolved / teardown；
// notify 通过构造注入（`(to, message) => void`），不直接 import commRouter，
// 让测试能注入 fake notify 断言。
//
// 设计要点：
// - 每个 item 至多 2 个 ticker 任务：reminder 和 timeout。
// - reminder 触发先 listApproachingDeadline(now, 0.1) 二次确认（防竞态 / 启动期已过窗口）；
//   命中后 markReminded + notify assignee + emit action_item.reminder。
// - timeout 触发先 listOverdue(now) 二次确认；命中后 repo.timeout + notify creator + emit action_item.timeout。
// - 短 deadline（deadline - createdAt < 60_000）fallback：reminder 时间取 deadline - 10_000。
// - boot 幂等：重复调用会根据当前 DB 状态重新注册。
// - 已过 reminder 窗口 / 已提醒过 / 已过 deadline 的 item：不注册 reminder，只注册 timeout（立即触发路径由 ticker 负责）。
import type { Ticker } from '../ticker/types.js';
import type { EventBus } from '../bus/events.js';
import {
  findById, listApproachingDeadline, listOverdue, listPending, markReminded, timeout as repoTimeout,
} from './repo.js';
import type { ActionItemRow } from './types.js';

const REMINDER_RATIO = 0.1;
const SHORT_DEADLINE_THRESHOLD = 60_000;
const SHORT_DEADLINE_LEAD = 10_000;

function reminderTaskId(itemId: string): string {
  return `action-item-reminder-${itemId}`;
}

function timeoutTaskId(itemId: string): string {
  return `action-item-timeout-${itemId}`;
}

// fallback 规则：短 deadline（span < 60s）优先"最少提前 10s"，
// 但若 span < 10s 导致 fallback 出负值，退化到 span*0.1 比例（= listApproachingDeadline 的筛子边界），
// 保证触发时 DB 二次确认一定能命中。
function computeReminderAt(item: ActionItemRow): number {
  const span = item.deadline - item.createdAt;
  const fallback = item.deadline - SHORT_DEADLINE_LEAD;
  const ratioBased = item.deadline - Math.floor(span * REMINDER_RATIO);
  if (span < SHORT_DEADLINE_THRESHOLD) {
    return fallback > item.createdAt ? fallback : ratioBased;
  }
  return ratioBased;
}

export class ActionItemScheduler {
  private readonly registered = new Set<string>();

  constructor(
    private readonly ticker: Ticker,
    private readonly eventBus: EventBus,
    private readonly notify: (to: string, message: string) => void,
  ) {}

  boot(): void {
    for (const item of listPending()) this.scheduleItem(item);
  }

  onItemCreated(item: ActionItemRow): void {
    this.scheduleItem(item);
  }

  onItemResolved(itemId: string): void {
    this.ticker.cancel(reminderTaskId(itemId));
    this.ticker.cancel(timeoutTaskId(itemId));
    this.registered.delete(reminderTaskId(itemId));
    this.registered.delete(timeoutTaskId(itemId));
  }

  teardown(): void {
    for (const id of this.registered) this.ticker.cancel(id);
    this.registered.clear();
  }

  private scheduleItem(item: ActionItemRow): void {
    const now = Date.now();
    if (item.status !== 'pending' && item.status !== 'in_progress') return;

    // reminder：未提醒 + deadline 还在未来 + reminderAt 仍在未来才注册。
    // 启动期若 reminderAt 已过（窗口已过），按 design §8.3 只注册 timeout，不补发 reminder（防启动时轰炸）。
    if (item.remindedAt == null && item.deadline > now) {
      const reminderAt = computeReminderAt(item);
      if (reminderAt > now) {
        this.scheduleTask(reminderTaskId(item.id), reminderAt, () => this.fireReminder(item.id));
      }
    }

    // timeout：总要注册（已过 deadline 的 item 在下一 tick 立即触发）。
    const timeoutFireAt = item.deadline <= now ? now + 1 : item.deadline;
    this.scheduleTask(timeoutTaskId(item.id), timeoutFireAt, () => this.fireTimeout(item.id));
  }

  private scheduleTask(id: string, fireAt: number, callback: () => void): void {
    this.ticker.schedule({ id, fireAt, callback });
    this.registered.add(id);
  }

  private fireReminder(itemId: string): void {
    this.registered.delete(reminderTaskId(itemId));
    const now = Date.now();
    const due = listApproachingDeadline(now, REMINDER_RATIO);
    const item = due.find((r) => r.id === itemId) ?? null;
    if (!item) return; // 二次确认未命中：状态已变 / 已提醒 / deadline 已过 → 静默退出
    markReminded(itemId, now);
    const remainingMs = Math.max(0, item.deadline - now);
    const minutes = Math.max(1, Math.round(remainingMs / 60_000));
    this.notify(item.assignee.id, `⏰ 任务 '${item.title}' 还剩 ${minutes} 分钟`);
    this.eventBus.emit({
      type: 'action_item.reminder',
      ts: new Date().toISOString(),
      source: 'action-item',
      itemId,
      assignee: item.assignee,
      remainingMs,
    });
  }

  private fireTimeout(itemId: string): void {
    this.registered.delete(timeoutTaskId(itemId));
    const now = Date.now();
    const overdue = listOverdue(now);
    const current = overdue.find((r) => r.id === itemId) ?? null;
    if (!current) {
      // 兜底：可能 deadline === now 卡在边界；直接读一次行确认。
      const row = findById(itemId);
      if (!row || (row.status !== 'pending' && row.status !== 'in_progress')) return;
      if (row.deadline > now) return;
    }

    const after = repoTimeout(itemId);
    if (!after) return;
    this.notify(after.creator.id, `超时了：'${after.title}'，check 下进度`);
    this.eventBus.emit({
      type: 'action_item.timeout',
      ts: new Date().toISOString(),
      source: 'action-item',
      item: after,
    });
  }
}
