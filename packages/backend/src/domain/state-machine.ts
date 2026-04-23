export type RoleStatus = 'PENDING' | 'ACTIVE' | 'PENDING_OFFLINE';
export type StateEvent =
  | 'activate'
  | 'register_session'
  | 'request_offline'
  | 'deactivate'
  | 'crash';

export interface TransitionRule {
  from: RoleStatus[];
  to: RoleStatus | null;
  terminal?: boolean;
}

export const TRANSITIONS: Record<StateEvent, TransitionRule> = {
  activate: { from: ['PENDING'], to: 'ACTIVE' },
  register_session: { from: ['PENDING'], to: 'ACTIVE' },
  request_offline: { from: ['ACTIVE'], to: 'PENDING_OFFLINE' },
  deactivate: { from: ['PENDING_OFFLINE'], to: null, terminal: true },
  crash: { from: ['PENDING', 'ACTIVE', 'PENDING_OFFLINE'], to: null, terminal: true },
};

export class IllegalTransitionError extends Error {
  readonly from: RoleStatus;
  readonly event: StateEvent;
  constructor(from: RoleStatus, event: StateEvent) {
    super(`Illegal transition: cannot apply '${event}' from state '${from}'`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.event = event;
  }
}

export function resolveTransition(event: StateEvent, current: RoleStatus): RoleStatus | null {
  const rule = TRANSITIONS[event];
  if (!rule || !rule.from.includes(current)) {
    throw new IllegalTransitionError(current, event);
  }
  return rule.to;
}
