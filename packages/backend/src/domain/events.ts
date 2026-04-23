import { EventEmitter } from 'node:events';

export const EVENTS = {
  ROLE_CREATED: 'role:created',
  ROLE_ACTIVATED: 'role:activated',
  ROLE_DELETED: 'role:deleted',
} as const;

export interface RoleCreatedEvent {
  instanceId: string;
  templateName: string;
  memberName: string;
  at: string;
}

export interface RoleActivatedEvent {
  instanceId: string;
  actor: string | null;
  at: string;
}

export interface RoleDeletedEvent {
  instanceId: string;
  at: string;
}

export const roleEvents: EventEmitter = new EventEmitter();
roleEvents.setMaxListeners(100);
