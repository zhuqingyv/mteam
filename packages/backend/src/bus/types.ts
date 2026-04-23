// 事件类型与 payload 定义。新增事件时在这里扩 BusEventType + interface + BusEvent 联合。
// 注意：events.ts 里的 EventBus.on<T>() 依赖 BusEvent 的字面量 discriminant，
// 拿到的 Observable 是类型收窄过的，所以 payload 字段变更会被 TS 编译检查到。
export type BusEventType =
  | 'instance.created'
  | 'instance.activated'
  | 'instance.offline_requested'
  | 'instance.deleted'
  | 'instance.session_registered'
  | 'pty.spawned'
  | 'pty.exited'
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
  | 'team.member_left';

export interface BusEventBase {
  type: BusEventType;
  ts: string;
  source: string;
  correlationId?: string;
}

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
}

export interface InstanceDeletedEvent extends BusEventBase {
  type: 'instance.deleted';
  instanceId: string;
  previousStatus: string;
  force: boolean;
}

export interface InstanceSessionRegisteredEvent extends BusEventBase {
  type: 'instance.session_registered';
  instanceId: string;
  claudeSessionId: string;
}

export interface PtySpawnedEvent extends BusEventBase {
  type: 'pty.spawned';
  instanceId: string;
  pid: number;
}

export interface PtyExitedEvent extends BusEventBase {
  type: 'pty.exited';
  instanceId: string;
  exitCode: number | null;
  signal: number | null;
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
  reason: 'manual' | 'instance_deleted';
}

export type BusEvent =
  | InstanceCreatedEvent
  | InstanceActivatedEvent
  | InstanceOfflineRequestedEvent
  | InstanceDeletedEvent
  | InstanceSessionRegisteredEvent
  | PtySpawnedEvent
  | PtyExitedEvent
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
  | TeamMemberLeftEvent;
