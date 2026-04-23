import { SqliteError } from 'better-sqlite3';
import { RoleTemplate } from '../../domain/role-template.js';
import type {
  CreateRoleTemplateInput,
  UpdateRoleTemplateInput,
  RoleTemplateProps,
} from '../../domain/role-template.js';

export interface ApiResponse {
  status: number;
  body: unknown;
}

const errRes = (status: number, error: string): ApiResponse => ({ status, body: { error } });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateName(v: unknown): string | null {
  if (typeof v !== 'string') return 'name is required';
  if (v.length < 1 || v.length > 64) return 'name must be 1~64 chars';
  return null;
}

function validateRole(v: unknown): string | null {
  if (typeof v !== 'string') return 'role is required';
  if (v.length < 1 || v.length > 32) return 'role must be 1~32 chars';
  return null;
}

function validateDescription(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return 'description must be string or null';
  if (v.length > 1024) return 'description must be ≤ 1024 chars';
  return null;
}

function validatePersona(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return 'persona must be string or null';
  if (v.length > 8192) return 'persona must be ≤ 8192 chars';
  return null;
}

function validateMcps(v: unknown): string | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return 'availableMcps must be an array of strings';
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string') return 'availableMcps must be an array of strings';
    if (item.length < 1 || item.length > 64) return 'availableMcps items must be 1~64 chars';
    if (seen.has(item)) return 'availableMcps must not contain duplicates';
    seen.add(item);
  }
  return null;
}

export function handleCreateTemplate(body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');
  const nameErr = validateName(body.name);
  if (nameErr) return errRes(400, nameErr);
  const roleErr = validateRole(body.role);
  if (roleErr) return errRes(400, roleErr);
  const descErr = validateDescription(body.description);
  if (descErr) return errRes(400, descErr);
  const personaErr = validatePersona(body.persona);
  if (personaErr) return errRes(400, personaErr);
  const mcpsErr = validateMcps(body.availableMcps);
  if (mcpsErr) return errRes(400, mcpsErr);

  const input: CreateRoleTemplateInput = {
    name: body.name as string,
    role: body.role as string,
    description: (body.description as string | null | undefined) ?? null,
    persona: (body.persona as string | null | undefined) ?? null,
    availableMcps: (body.availableMcps as string[] | undefined) ?? [],
  };
  try {
    const tpl = RoleTemplate.create(input);
    return { status: 201, body: tpl.toJSON() };
  } catch (e) {
    if (e instanceof SqliteError && e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return errRes(409, `template '${input.name}' already exists`);
    }
    if (e instanceof SqliteError && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) {
      return errRes(409, `template '${input.name}' already exists`);
    }
    throw e;
  }
}

export function handleListTemplates(): ApiResponse {
  const list = RoleTemplate.listAll();
  const body: RoleTemplateProps[] = list.map((t) => t.toJSON());
  return { status: 200, body };
}

export function handleGetTemplate(name: string): ApiResponse {
  const tpl = RoleTemplate.findByName(name);
  if (!tpl) return errRes(404, `template '${name}' not found`);
  return { status: 200, body: tpl.toJSON() };
}

export function handleUpdateTemplate(name: string, body: unknown): ApiResponse {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');
  if ('role' in body) {
    const err = validateRole(body.role);
    if (err) return errRes(400, err);
  }
  if ('description' in body) {
    const err = validateDescription(body.description);
    if (err) return errRes(400, err);
  }
  if ('persona' in body) {
    const err = validatePersona(body.persona);
    if (err) return errRes(400, err);
  }
  if ('availableMcps' in body) {
    const err = validateMcps(body.availableMcps);
    if (err) return errRes(400, err);
  }

  const existing = RoleTemplate.findByName(name);
  if (!existing) return errRes(404, `template '${name}' not found`);

  const patch: UpdateRoleTemplateInput = {};
  if ('role' in body) patch.role = body.role as string;
  if ('description' in body) patch.description = body.description as string | null;
  if ('persona' in body) patch.persona = body.persona as string | null;
  if ('availableMcps' in body) patch.availableMcps = body.availableMcps as string[];

  const updated = RoleTemplate.update(name, patch);
  return { status: 200, body: updated.toJSON() };
}

export function handleDeleteTemplate(name: string): ApiResponse {
  const existing = RoleTemplate.findByName(name);
  if (!existing) return errRes(404, `template '${name}' not found`);
  try {
    RoleTemplate.delete(name);
    return { status: 204, body: null };
  } catch (e) {
    if (e instanceof SqliteError && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) {
      return errRes(409, `template '${name}' is still referenced by active role instances`);
    }
    throw e;
  }
}
