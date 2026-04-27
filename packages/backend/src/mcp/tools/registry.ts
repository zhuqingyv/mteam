import type { MteamEnv } from '../config.js';
import type { CommLike } from '../comm-like.js';
import { activateSchema, runActivate } from './activate.js';
import { deactivateSchema, runDeactivate } from './deactivate.js';
import { requestOfflineSchema, runRequestOffline } from './request_offline.js';
import { sendMsgSchema, runSendMsg } from './send_msg.js';
import { checkInboxSchema, runCheckInbox } from './check_inbox.js';
import { lookupSchema, runLookup } from './lookup.js';
import { addMemberSchema, runAddMember } from './add_member.js';
import { listMembersSchema, runListMembers } from './list_members.js';
import { readMessageSchema, runReadMessage } from './read_message.js';

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ToolDeps {
  env: MteamEnv;
  comm: CommLike;
}

export type ToolHandler = (
  deps: ToolDeps,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface ToolEntry {
  schema: ToolSchema;
  handler: ToolHandler;
  leaderOnly: boolean;
}

export const ALL_TOOLS: ToolEntry[] = [
  {
    schema: activateSchema,
    handler: ({ env }) => runActivate(env),
    leaderOnly: false,
  },
  {
    schema: deactivateSchema,
    handler: ({ env }) => runDeactivate(env),
    leaderOnly: false,
  },
  {
    schema: sendMsgSchema,
    handler: ({ env, comm }, args) => runSendMsg(env, comm, args),
    leaderOnly: false,
  },
  {
    schema: checkInboxSchema,
    handler: ({ env }, args) => runCheckInbox(env, args),
    leaderOnly: false,
  },
  {
    schema: lookupSchema,
    handler: ({ env }, args) => runLookup(env, args),
    leaderOnly: false,
  },
  {
    schema: requestOfflineSchema,
    handler: ({ env }, args) => runRequestOffline(env, args),
    leaderOnly: true,
  },
  {
    schema: addMemberSchema,
    handler: ({ env }, args) => runAddMember(env, args),
    leaderOnly: true,
  },
  {
    schema: listMembersSchema,
    handler: ({ env }) => runListMembers(env),
    leaderOnly: false,
  },
  {
    schema: readMessageSchema,
    handler: ({ env }, args) => runReadMessage(env, args),
    leaderOnly: false,
  },
];

export function visibleTools(isLeader: boolean): ToolEntry[] {
  return ALL_TOOLS.filter((t) => !t.leaderOnly || isLeader);
}

export function findTool(name: string): ToolEntry | undefined {
  return ALL_TOOLS.find((t) => t.schema.name === name);
}
