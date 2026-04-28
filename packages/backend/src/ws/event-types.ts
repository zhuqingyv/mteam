// W1-8 · WS 白名单独立（S3 时序第一步）。
//
// 把 WS_EVENT_TYPES 从 bus/subscribers/ws.subscriber.ts 提出来，让 ws/* 模块
// 可以不 import 整个旧 subscriber 文件（含 WsBroadcaster class）就能访问白名单。
// 旧 ws.subscriber.ts 改为 re-export 本文件，保持向后兼容；W2-5 删除旧
// WsBroadcaster class 时，ws.subscriber.ts 最终只剩 re-export。
//
// 新增 Bus 事件时，这里是"是否暴露给前端"的唯一决策点。默认不加，除非前端确有渲染需求。
// W2-H 守门测试（bus/subscribers/ws.subscriber.test.ts）通过 re-export 路径
// 继续跑，断言 size 与关键成员，防止白名单悄悄漂移。
//
// 只 import type，零业务依赖（Wave 1 非业务约束）。
import type { BusEventType } from '../bus/types.js';

export const WS_EVENT_TYPES: ReadonlySet<BusEventType> = new Set<BusEventType>([
  'instance.created',
  'instance.activated',
  'instance.offline_requested',
  'instance.deleted',
  'instance.session_registered',
  'comm.registered',
  'comm.disconnected',
  'comm.message_sent',
  'comm.message_received',
  'template.created',
  'template.updated',
  'template.deleted',
  'mcp.installed',
  'mcp.uninstalled',
  'team.created',
  'team.disbanded',
  'team.member_joined',
  'team.member_left',
  'cli.available',
  'cli.unavailable',
  'primary_agent.started',
  'primary_agent.stopped',
  'primary_agent.configured',
  'primary_agent.state_changed',
  'driver.started',
  'driver.stopped',
  'driver.error',
  'turn.started',
  'turn.block_updated',
  'turn.completed',
  'turn.error',
  'container.started',
  'container.exited',
  'container.crashed',
  'notification.delivered',
  'action_item.created',
  'action_item.updated',
  'action_item.reminder',
  'action_item.resolved',
  'action_item.timeout',
  'worker.status_changed',
]);
