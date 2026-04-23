// PTY subscriber —— instance.created 触发 ptyManager.spawn，成功后 emit pty.spawned。
// 已知限制：spawn 失败只打 stderr，handler 已 return 201，instance 行会残留 PENDING。
// 设计文档 §8.1 承认这是为了先拆简单副作用的短期妥协；若要回到"失败回滚"语义，
// 需要再补一个失败事件 + 由 domain-sync 回收 instance。
import { Subscription } from 'rxjs';
import { bus as defaultBus, type EventBus } from '../events.js';
import { makeBase } from '../helpers.js';
import { ptyManager } from '../../pty/manager.js';
import { RoleTemplate } from '../../domain/role-template.js';

export function subscribePty(eventBus: EventBus = defaultBus): Subscription {
  const sub = new Subscription();

  sub.add(
    eventBus.on('instance.created').subscribe((e) => {
      try {
        const template = RoleTemplate.findByName(e.templateName);
        if (!template) {
          process.stderr.write(
            `[bus/pty] template '${e.templateName}' not found for ${e.instanceId}, skip spawn\n`,
          );
          return;
        }
        // FIXME(回归): leaderName 暂硬编码为 null，因 InstanceCreatedEvent 未携带该字段。
        // 改造前 handler 直接读 instance.leaderName 传 spawn；改造后 assemblePrompt
        // 里"向 leader 汇报"部分会丢失。修复需在事件 payload 加 leaderName 字段。
        const entry = ptyManager.spawn({
          instanceId: e.instanceId,
          memberName: e.memberName,
          isLeader: e.isLeader,
          leaderName: null,
          task: e.task,
          persona: template.persona,
          availableMcps: template.availableMcps,
        });
        eventBus.emit({
          ...makeBase('pty.spawned', 'pty', e.correlationId),
          instanceId: e.instanceId,
          pid: entry.pid,
        });
      } catch (err) {
        process.stderr.write(
          `[bus/pty] spawn failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  sub.add(
    eventBus.on('instance.deleted').subscribe((e) => {
      try {
        ptyManager.kill(e.instanceId);
      } catch (err) {
        process.stderr.write(
          `[bus/pty] kill failed for ${e.instanceId}: ${(err as Error).message}\n`,
        );
      }
    }),
  );

  return sub;
}
