// Phase 5 W2 · 工作流模板 HTTP 接口（list / create / launch）
// launch 走现有 HTTP 面（/api/role-instances + /api/teams/... + /members），保 bus 事件链完整。
// 设计：docs/phase5/workflow-templates-design.md §4.2
import type http from 'node:http';
import type { ApiResponse } from '../../api/panel/role-templates.js';
import { readBody, notFound } from '../http-utils.js';
import { createWorkflow, findByName, listAll } from '../../workflow/repo.js';
import type { CreateWorkflowInput, WorkflowRole, WorkflowTemplate } from '../../workflow/types.js';

const PREFIX = '/api/workflows';
const err = (status: number, error: string): ApiResponse => ({ status, body: { error } });
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export async function handleWorkflowsRoute(
  req: http.IncomingMessage, pathname: string, method: string,
): Promise<ApiResponse | null> {
  if (pathname === PREFIX) {
    if (method === 'GET') return { status: 200, body: listAll() };
    if (method === 'POST') return handleCreate(await readBody(req));
    return notFound;
  }
  if (pathname.startsWith(PREFIX + '/')) {
    const parts = pathname.slice(PREFIX.length + 1).split('/');
    if (parts.length === 2 && parts[0] && parts[1] === 'launch' && method === 'POST') {
      const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost';
      return handleLaunch(parts[0], await readBody(req), `http://${host}`);
    }
    return notFound;
  }
  return null;
}

function handleCreate(body: unknown): ApiResponse {
  if (!isObj(body)) return err(400, 'body must be a JSON object');
  if (typeof body.name !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(body.name)) {
    return err(400, 'name must match ^[a-z][a-z0-9-]{1,63}$');
  }
  if (typeof body.label !== 'string' || body.label.length < 1) return err(400, 'label is required');
  if (!Array.isArray(body.roles) || body.roles.length === 0) return err(400, 'roles must be a non-empty array');
  let leaderCount = 0;
  for (const r of body.roles as unknown[]) {
    if (!isObj(r) || typeof r.templateName !== 'string' || typeof r.isLeader !== 'boolean') {
      return err(400, 'each role must have templateName:string + isLeader:boolean');
    }
    if (r.isLeader) leaderCount++;
  }
  if (leaderCount !== 1) return err(400, 'roles must contain exactly one leader');
  if (findByName(body.name)) return err(409, `workflow '${body.name}' already exists`);
  const input: CreateWorkflowInput = {
    name: body.name, label: body.label,
    description: typeof body.description === 'string' ? body.description : null,
    icon: typeof body.icon === 'string' ? body.icon : null,
    roles: body.roles as WorkflowRole[],
    taskChain: Array.isArray(body.taskChain) ? (body.taskChain as WorkflowTemplate['taskChain']) : [],
    builtin: false,
  };
  return { status: 201, body: createWorkflow(input) };
}

function render(tpl: string | undefined, vars: Record<string, string>): string | null {
  if (!tpl) return null;
  return tpl.replace(/\{\{(goal|projectName|deadline)\}\}/g, (_, k) => vars[k] ?? '');
}

async function handleLaunch(name: string, body: unknown, hubUrl: string): Promise<ApiResponse> {
  const tpl = findByName(name);
  if (!tpl) return err(404, `workflow '${name}' not found`);
  if (!isObj(body)) return err(400, 'body must be a JSON object');
  const projectName = typeof body.projectName === 'string' ? body.projectName : '';
  const goal = typeof body.goal === 'string' ? body.goal : '';
  if (!projectName) return err(400, 'projectName is required');
  if (!goal) return err(400, 'goal is required');
  const deadline = typeof body.deadline === 'number' ? body.deadline : undefined;
  const vars: Record<string, string> = {
    goal, projectName, deadline: deadline !== undefined ? String(deadline) : '',
  };
  const leaderRole = tpl.roles.find((r) => r.isLeader);
  if (!leaderRole) return err(500, `workflow '${name}' has no leader role`);

  const leaderRes = await post(`${hubUrl}/api/role-instances`, {
    templateName: leaderRole.templateName, memberName: `${tpl.label}-leader`,
    isLeader: true, task: render(leaderRole.task, vars),
  });
  if (leaderRes.status !== 201) return leaderRes;
  const leaderId = (leaderRes.body as { id: string }).id;

  const teamRes = await post(`${hubUrl}/api/teams`, {
    name: projectName, leaderInstanceId: leaderId, description: tpl.description ?? undefined,
  });
  if (teamRes.status !== 201) return teamRes;
  const teamId = (teamRes.body as { id: string }).id;

  const members: Array<{ templateName: string; instanceId: string }> = [];
  for (const role of tpl.roles.filter((r) => !r.isLeader)) {
    const mRes = await post(`${hubUrl}/api/role-instances`, {
      templateName: role.templateName, memberName: `${tpl.label}-${role.templateName}`,
      isLeader: false, task: render(role.task, vars),
    });
    if (mRes.status !== 201) return mRes;
    const mid = (mRes.body as { id: string }).id;
    await post(`${hubUrl}/api/teams/${encodeURIComponent(teamId)}/members`, { instanceId: mid });
    members.push({ templateName: role.templateName, instanceId: mid });
  }
  return { status: 201, body: { teamId, leaderId, members } };
}

async function post(url: string, body: unknown): Promise<ApiResponse> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
