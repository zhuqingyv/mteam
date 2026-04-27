// member-driver / replay —— 成员 driver 启动后的离线消息回灌。
//
// 接法：纯函数，不订阅 bus。由 lifecycle 在 driver.start() 成功并
// driverRegistry.register() 之后、一次性 await replayForDriver(...)。
//
// v2（W2-F）：源切换到 messageStore（envelope 维度），通知行 formatNotifyLine 带 msg_id，
// agent 上线后对每条通知调 read_message(msg_id) 拿全文。markRead 替代 offline.markDelivered。
import type { AgentDriver } from '../../../agent-driver/driver.js';
import type { MessageStore } from '../../../comm/message-store.js';
import { createMessageStore } from '../../../comm/message-store.js';
import { formatNotifyLine } from '../../../member-agent/format-message.js';

export interface ReplayResult {
  total: number;
  delivered: number;
  failed: number;
}

/**
 * 回灌 instanceId 的所有未读消息。串行 await driver.prompt；成功后 markRead。
 * 单条失败 stderr 记一条、不中断后续；driver 中途 stop 则后续条目都抛，留在未读中。
 */
export async function replayForDriver(
  instanceId: string,
  driver: AgentDriver,
  deps?: { store?: MessageStore },
): Promise<ReplayResult> {
  const store = deps?.store ?? createMessageStore();
  const pending = store.findUnreadFor(instanceId);
  const result: ReplayResult = { total: pending.length, delivered: 0, failed: 0 };
  if (pending.length === 0) return result;

  for (const env of pending) {
    const text = formatNotifyLine({
      envelopeId: env.id,
      fromDisplayName: env.from.displayName,
      summary: env.summary,
    });
    try {
      await driver.prompt(text);
      store.markRead(env.id);
      result.delivered += 1;
    } catch (err) {
      result.failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(
        `[member-driver/replay] prompt failed instance=${instanceId} msg=${env.id}: ${reason}`,
      );
    }
  }

  return result;
}
