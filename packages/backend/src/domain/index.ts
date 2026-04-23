export { getDb, closeDb } from '../db/connection.js';
export {
  TRANSITIONS,
  IllegalTransitionError,
  resolveTransition,
} from './state-machine.js';
export type { RoleStatus, StateEvent, TransitionRule } from './state-machine.js';
export { RoleTemplate } from './role-template.js';
export type {
  RoleTemplateProps,
  CreateRoleTemplateInput,
  UpdateRoleTemplateInput,
} from './role-template.js';
export { RoleInstance } from './role-instance.js';
export type {
  RoleInstanceProps,
  CreateRoleInstanceInput,
} from './role-instance.js';
