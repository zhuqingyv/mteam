// > 前端请走 /api/panel/teams/* 门面层，不要直接调用本接口。
import type http from 'node:http';
import type { ApiResponse } from '../../api/panel/role-templates.js';
import {
  handleListTeams,
  handleGetTeam,
  handleCreateTeam,
  handleDisbandTeam,
  handleListMembers,
  handleAddMember,
  handleRemoveMember,
  handleGetTeamByInstance,
} from '../../api/panel/teams.js';
import { readBody, notFound } from '../http-utils.js';

const TEAMS_PREFIX = '/api/teams';

export async function handleTeamsRoute(
  req: http.IncomingMessage,
  pathname: string,
  method: string,
): Promise<ApiResponse | null> {
  if (pathname === TEAMS_PREFIX) {
    if (method === 'GET') return handleListTeams();
    if (method === 'POST') return handleCreateTeam(await readBody(req));
    return notFound;
  }

  if (pathname.startsWith(TEAMS_PREFIX + '/')) {
    const rest = pathname.slice(TEAMS_PREFIX.length + 1);
    const parts = rest.split('/');
    if (parts.length === 2 && parts[0] === 'by-instance' && parts[1]) {
      if (method === 'GET') return handleGetTeamByInstance(parts[1]);
      return notFound;
    }
    if (parts.length === 1 && parts[0]) {
      if (method === 'GET') return handleGetTeam(parts[0]);
      return notFound;
    }
    if (parts.length === 2 && parts[0] && parts[1] === 'disband' && method === 'POST') {
      return handleDisbandTeam(parts[0]);
    }
    if (parts.length === 2 && parts[0] && parts[1] === 'members') {
      if (method === 'GET') return handleListMembers(parts[0]);
      if (method === 'POST') return handleAddMember(parts[0], await readBody(req));
      return notFound;
    }
    if (parts.length === 3 && parts[0] && parts[1] === 'members' && parts[2]) {
      if (method === 'DELETE') return handleRemoveMember(parts[0], parts[2]);
      return notFound;
    }
    return notFound;
  }

  return null;
}
