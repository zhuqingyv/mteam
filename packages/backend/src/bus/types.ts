// 事件类型与 payload 定义。新增事件时在这里扩 BusEventType + interface + BusEvent 联合。
// 注意：events.ts 里的 EventBus.on<T>() 依赖 BusEvent 的字面量 discriminant，
// 拿到的 Observable 是类型收窄过的，所以 payload 字段变更会被 TS 编译检查到。
//
// T-7 拆分：driver.* 事件 interface 移到 driver-events.ts；turn.* 事件 interface 移到
// turn-events.ts。本文件保留：BusEventBase / BusEventType 总 union / BusEvent 总 union /
// 非 driver-非 turn 事件 interface（instance / comm / template / mcp / team / cli /
// primary_agent / container / notification）。消费方继续从 '../bus/types.js' 导入，路径不变。
//
// 行数记账：本文件轻微超 200 行红线（约 320 行），主因是 BusEventType 总 union（44 行）
// + BusEvent 总 union（30 行）+ 13 个非 driver/turn 事件 interface 必须在这里收口。
// 继续拆 instance/comm 等域属过度工程，不在 T-7 范围，此处显式记账。
import type { DriverBusEvent } from './driver-events.js';
import type { TurnBusEvent } from './turn-events.js';
import type { PrimaryAgentRow } from '../primary-agent/types.js';
import type { ActionItem, ActorId } from '../action-item/types.js';

// ---------- 事件类型联合（全部事件域并入）----------

export type BusEventType =
  | 'instance.created'
  | 'instance.activated'
  | 'instance.offline_requested'
  | 'instance.deleted'
  | 'instance.session_registered'
  | 'comm.registered'
  | 'comm.disconnected'
  | 'comm.message_sent'
  | 'comm.message_received'
  | 'template.created'
  | 'template.updated'
  | 'template.deleted'
  | 'mcp.installed'
  | 'mcp.uninstalled'
  | 'team.created'
  | 'team.disbanded'
  | 'team.member_joined'
  | 'team.member_left'
  | 'cli.available'
  | 'cli.unavailable'
  | 'primary_agent.started'
  | 'primary_agent.stopped'
  | 'primary_agent.configured'
  | 'primary_agent.state_changed'
  | 'driver.started'
  | 'driver.stopped'
  | 'driver.error'
  | 'driver.thinking'
  | 'driver.text'
  | 'driver.tool_call'
  | 'driver.tool_result'
  | 'driver.tool_update'
  | 'driver.plan'
  | 'driver.commands'
  | 'driver.mode'
  | 'driver.config'
  | 'driver.session_info'
  | 'driver.usage'
  | 'driver.turn_start'
  | 'driver.turn_done'
  | 'turn.started'
  | 'turn.block_updated'
  | 'turn.completed'
  | 'turn.error'
  | 'container.started'
  | 'container.exited'
  | 'container.crashed'
  | 'notification.delivered'
  | 'runtime.fatal'
  | 'memory.warn'
  | 'process.reaped'
  | 'action_item.created'
  | 'action_item.updated'
  | 'action_item.reminder'
  | 'action_item.resolved'
  | 'action_item.timeout';

export interface BusEventBase {
  type: BusEventType;
  ts: string;
  source: string;
  correlationId?: string;
  /** A5 接线：每条 bus 事件的唯一下行 id。makeBase 自动填 UUID；comm.* 继续用 messageId。 */
  eventId?: string;
}

// ---------- instance / comm / template / mcp / team / cli / primary_agent ----------

export interface InstanceCreatedEvent extends BusEventBase {
  type: 'instance.created';
  instanceId: string;
  templateName: string;
  memberName: string;
  isLeader: boolean;
  teamId: string | null;
  task: string | null;
}

export interface InstanceActivatedEvent extends BusEventBase {
  type: 'instance.activated';
  instanceId: string;
  actor: string | null;
}

export interface InstanceOfflineRequestedEvent extends BusEventBase {
  type: 'instance.offline_requested';
  instanceId: string;
  requestedBy: string;
  // Stage 5 M7：policy-enforcer 违规下线时透传原因，审计通过 log.subscriber 读该字段识别来源。
  // 其他 requestedBy 来源（team-cascade / manual / team-disband 等）留空即可。
  reason?: 'explicit_deny' | 'not_in_whitelist' | string;
}

export interface InstanceDeletedEvent extends BusEventBase {
  type: 'instance.deleted';
  instanceId: string;
  previousStatus: string;
  force: boolean;
  // teamId / isLeader：emit 端（handleDeleteInstance）在 instance.delete() 之前抓快照
  // 带过来。CASCADE 发生后 team 行可能已消失，subscriber 不能再 findByInstance。
  teamId: string | null;
  isLeader: boolean;
}

export interface InstanceSessionRegisteredEvent extends BusEventBase {
  type: 'instance.session_registered';
  instanceId: string;
  claudeSessionId: string;
}

export interface CommRegisteredEvent extends BusEventBase {
  type: 'comm.registered';
  address: string;
}

export interface CommDisconnectedEvent extends BusEventBase {
  type: 'comm.disconnected';
  address: string;
}

export interface CommMessageSentEvent extends BusEventBase {
  type: 'comm.message_sent';
  messageId: string;
  from: string;
  to: string;
}

export interface CommMessageReceivedEvent extends BusEventBase {
  type: 'comm.message_received';
  messageId: string;
  from: string;
  to: string;
  route: string;
}

export interface TemplateCreatedEvent extends BusEventBase {
  type: 'template.created';
  templateName: string;
}

export interface TemplateUpdatedEvent extends BusEventBase {
  type: 'template.updated';
  templateName: string;
}

export interface TemplateDeletedEvent extends BusEventBase {
  type: 'template.deleted';
  templateName: string;
}

export interface McpInstalledEvent extends BusEventBase {
  type: 'mcp.installed';
  mcpName: string;
}

export interface McpUninstalledEvent extends BusEventBase {
  type: 'mcp.uninstalled';
  mcpName: string;
}

export interface TeamCreatedEvent extends BusEventBase {
  type: 'team.created';
  teamId: string;
  name: string;
  leaderInstanceId: string;
}

export interface TeamDisbandedEvent extends BusEventBase {
  type: 'team.disbanded';
  teamId: string;
  reason: 'manual' | 'empty' | 'leader_gone';
}

export interface TeamMemberJoinedEvent extends BusEventBase {
  type: 'team.member_joined';
  teamId: string;
  instanceId: string;
  roleInTeam: string | null;
}

export interface TeamMemberLeftEvent extends BusEventBase {
  type: 'team.member_left';
  teamId: string;
  instanceId: string;
  reason: 'manual' | 'instance_deleted' | 'offline_requested';
}

export interface CliAvailableEvent extends BusEventBase {
  type: 'cli.available';
  cliName: string;
  path: string;
  version: string | null;
}

export interface CliUnavailableEvent extends BusEventBase {
  type: 'cli.unavailable';
  cliName: string;
}

export interface PrimaryAgentStartedEvent extends BusEventBase {
  type: 'primary_agent.started';
  agentId: string;
  cliType: string;
}

export interface PrimaryAgentStoppedEvent extends BusEventBase {
  type: 'primary_agent.stopped';
  agentId: string;
}

export interface PrimaryAgentStateChangedEvent extends BusEventBase {
  type: 'primary_agent.state_changed';
  agentId: string;
  agentState: 'idle' | 'thinking' | 'responding';
}

export interface PrimaryAgentConfiguredEvent extends BusEventBase {
  type: 'primary_agent.configured';
  agentId: string;
  cliType: string;
  name: string;
  /** WS-Primary W2-0：完整 Row，字段与 ws-snapshot 对齐。顶层冗余 cliType/name 留给老消费方。 */
  row: PrimaryAgentRow;
}

// ---------- driver.* / turn.* 事件：re-export 让消费方路径不变 ----------

export type {
  DriverStartedEvent,
  DriverStoppedEvent,
  DriverErrorEvent,
  DriverThinkingEvent,
  DriverTextEvent,
  DriverToolCallEvent,
  DriverToolResultEvent,
  DriverToolUpdateEvent,
  DriverPlanEvent,
  DriverCommandsEvent,
  DriverModeEvent,
  DriverConfigEvent,
  DriverSessionInfoEvent,
  DriverUsageEvent,
  DriverTurnStartEvent,
  DriverTurnDoneEvent,
  DriverBusEvent,
  DriverBusEventType,
} from './driver-events.js';

export type {
  TurnStartedEvent,
  TurnBlockUpdatedEvent,
  TurnCompletedEvent,
  TurnErrorEvent,
  TurnBusEvent,
  TurnBusEventType,
} from './turn-events.js';

// ---------- worker ----------

// 数字员工状态变化事件。由 worker-status.subscriber 监听 instance.* / driver.* /
// turn.* 后重算，发现变化才 emit。前端走 WS 增量更新，避免轮询。
// status 字面量与 worker/types.ts 的 WorkerStatus 保持一致。
export interface WorkerStatusChangedEvent extends BusEventBase {
  type: 'worker.status_changed';
  name: string;
  status: 'online' | 'idle' | 'offline';
  instanceCount: number;
  teams: string[];
}

// ---------- container / notification ----------

// Container 生命周期事件：Stage 5 沙箱化，container.subscriber 根据 runtime 选择
// 发出。containerId 在 HostRuntime 下 = String(pid)；crashed 仅用于非零退出且非
// 用户主动的场景（用户 stop 路径直接走 exited(reason='stop_requested')）。
export interface ContainerStartedEvent extends BusEventBase {
  type: 'container.started';
  agentId: string;
  runtimeKind: 'host' | 'docker';
  containerId: string;
}

export interface ContainerExitedEvent extends BusEventBase {
  type: 'container.exited';
  agentId: string;
  reason: 'stop_requested' | 'max_restart_exceeded' | 'normal_exit';
  exitCode: number | null;
}

export interface ContainerCrashedEvent extends BusEventBase {
  type: 'container.crashed';
  agentId: string;
  cliType: string;
  exitCode: number;
  signal: number | null;
}

// Phase WS W2-6：notification.subscriber 路由决策后，对 user/agent 目标
// 直接推一条"通知指针"事件，由 ws-broadcaster 按订阅投递给对应连接。
// 不带 sourceEventPayload —— 前端按 sourceEventId 在本地缓存里找原事件，
// 避免订 global 同时收到原事件 + 通知副本导致 UI 双推。
//
// Phase 5 W2：notification-center/repo.pushNotification 落库后也走这条事件，
// 携带 notificationId + title + body + channel 让前端直接触发 OS 通知。
// 原 W2-6 路径只填 target + sourceEventType + sourceEventId；两条路径并存，
// 前端按存在的字段判定来源。因此 source*/target 改为可选（向后兼容扩展）。
export interface NotificationDeliveredEvent extends BusEventBase {
  type: 'notification.delivered';
  target?: { kind: 'user'; id: string } | { kind: 'agent'; id: string };
  sourceEventType?: string;
  sourceEventId?: string;
  /** Phase 5：持久化通知的 id，前端可用它去 HTTP ack。 */
  notificationId?: string;
  /** Phase 5：通知类型渠道，决定是否触发 OS 通知（system / in_app / both）。 */
  channel?: string;
  /** Phase 5：通知级别 info/warn/error，前端用于 OS 通知图标/声音映射。 */
  severity?: string;
  /** Phase 5：通知分类（quota_limit / action_item_reminder ...），给前端 kind-aware 渲染。 */
  kind?: string;
  /** Phase 5：OS 通知标题，缺省时前端可退化用 sourceEventType。 */
  title?: string;
  /** Phase 5：OS 通知正文。 */
  body?: string;
  /** Phase 5：结构化 payload，给前端渲染辅助字段（如 quota 详情）。 */
  payload?: Record<string, unknown>;
}

// ---------- reliability 域（W1-7 · Phase Reliability）----------

// Phase Reliability W2-1：process 级 fatal handler 捕获 unhandledRejection /
// uncaughtException 后，把错误上报到 bus 供观测与审计。uncaught 路径会继续触发
// shutdown；unhandled 不触发退出（仅记录）。kind 区分来源，message/stack 吞掉
// 原 Error 对象避免跨 subscriber 语义漂移。
export interface RuntimeFatalEvent extends BusEventBase {
  type: 'runtime.fatal';
  kind: 'unhandledRejection' | 'uncaughtException';
  message: string;
  stack?: string;
}

// Phase Reliability W1-4：MemoryManager 内存水位告警。集合 size 超过
// warnThreshold * maxSize 时触发。collection 是 register 时传入的名字，
// strategy 透传让排障可直接判断淘汰路径。
export interface MemoryWarnEvent extends BusEventBase {
  type: 'memory.warn';
  collection: string;
  size: number;
  maxSize: number;
  strategy: 'lru' | 'ttl' | 'fifo';
}

// Phase Reliability W2-x：孤儿进程清扫（S5 snapshot 重启后对比 pid 文件）。
// reason='orphan' 表示从历史 snapshot 里读出、父进程已不在的 pid；
// reason='stale_temp' 表示虽已自然退出但 tempFiles 没清掉。owner 来自
// ManagedProcess.owner，空值代表 snapshot 里没记（老版本数据）。
export interface ProcessReapedEvent extends BusEventBase {
  type: 'process.reaped';
  pid: number;
  owner: string | null;
  reason: 'orphan' | 'stale_temp';
}

// ---------- action_item 域（Phase 4 · C-4）----------
// source 约定为 'action-item'。created/updated/resolved/timeout 由 ws-broadcaster
// 按 creator/assignee/teamId 三个维度投递；reminder 仅投递给 assignee。

export interface ActionItemCreatedEvent extends BusEventBase {
  type: 'action_item.created';
  item: ActionItem;
}

export interface ActionItemUpdatedEvent extends BusEventBase {
  type: 'action_item.updated';
  item: ActionItem;
  /** 本次变更的字段清单，便于前端增量更新。 */
  changed: Array<'status' | 'title' | 'description' | 'deadline' | 'remindedAt' | 'resolution'>;
}

export interface ActionItemReminderEvent extends BusEventBase {
  type: 'action_item.reminder';
  itemId: string;
  assignee: ActorId;
  /** 剩余时间（ms）。 */
  remainingMs: number;
}

export interface ActionItemResolvedEvent extends BusEventBase {
  type: 'action_item.resolved';
  item: ActionItem;
  outcome: 'done' | 'rejected' | 'cancelled';
}

export interface ActionItemTimeoutEvent extends BusEventBase {
  type: 'action_item.timeout';
  item: ActionItem;
}

// ---------- BusEvent 总联合 ----------

export type BusEvent =
  | InstanceCreatedEvent
  | InstanceActivatedEvent
  | InstanceOfflineRequestedEvent
  | InstanceDeletedEvent
  | InstanceSessionRegisteredEvent
  | CommRegisteredEvent
  | CommDisconnectedEvent
  | CommMessageSentEvent
  | CommMessageReceivedEvent
  | TemplateCreatedEvent
  | TemplateUpdatedEvent
  | TemplateDeletedEvent
  | McpInstalledEvent
  | McpUninstalledEvent
  | TeamCreatedEvent
  | TeamDisbandedEvent
  | TeamMemberJoinedEvent
  | TeamMemberLeftEvent
  | CliAvailableEvent
  | CliUnavailableEvent
  | PrimaryAgentStartedEvent
  | PrimaryAgentStoppedEvent
  | PrimaryAgentConfiguredEvent
  | PrimaryAgentStateChangedEvent
  | DriverBusEvent
  | TurnBusEvent
  | ContainerStartedEvent
  | ContainerExitedEvent
  | ContainerCrashedEvent
  | NotificationDeliveredEvent
  | RuntimeFatalEvent
  | MemoryWarnEvent
  | ProcessReapedEvent
  | ActionItemCreatedEvent
  | ActionItemUpdatedEvent
  | ActionItemReminderEvent
  | ActionItemResolvedEvent
  | ActionItemTimeoutEvent
  | WorkerStatusChangedEvent;
