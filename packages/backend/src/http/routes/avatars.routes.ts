// > 前端请走 /api/panel/avatars/* 门面层，不要直接调用本接口。
import type http from 'node:http';
import type { ApiResponse } from '../../api/panel/role-templates.js';
import {
  listVisible,
  addCustom,
  remove,
  restoreBuiltins,
  randomOne,
  findById,
} from '../../avatar/repo.js';
import { readBody, notFound } from '../http-utils.js';

const PREFIX = '/api/avatars';
const RANDOM = '/api/avatars/random';
const RESTORE = '/api/avatars/restore';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateId(v: unknown): string | null {
  if (typeof v !== 'string') return 'id is required';
  if (v.length < 1 || v.length > 64) return 'id must be 1~64 chars';
  return null;
}

function validateFilename(v: unknown): string | null {
  if (typeof v !== 'string') return 'filename is required';
  if (v.length < 1 || v.length > 255) return 'filename must be 1~255 chars';
  return null;
}

const errRes = (status: number, error: string): ApiResponse => ({ status, body: { error } });

export async function handleAvatarsRoute(
  req: http.IncomingMessage,
  pathname: string,
  method: string,
): Promise<ApiResponse | null> {
  if (pathname === RANDOM) {
    if (method === 'GET') {
      const avatar = randomOne();
      return { status: 200, body: { avatar: avatar ?? null } };
    }
    return notFound;
  }

  if (pathname === RESTORE) {
    if (method === 'POST') {
      const restored = restoreBuiltins();
      return { status: 200, body: { restored } };
    }
    return notFound;
  }

  if (pathname === PREFIX) {
    if (method === 'GET') {
      return { status: 200, body: { avatars: listVisible() } };
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (!isPlainObject(body)) return errRes(400, 'body must be an object');
      const idErr = validateId(body.id);
      if (idErr) return errRes(400, idErr);
      const filenameErr = validateFilename(body.filename);
      if (filenameErr) return errRes(400, filenameErr);
      try {
        const row = addCustom(body.id as string, body.filename as string);
        return {
          status: 201,
          body: { id: row.id, filename: row.filename, builtin: row.builtin },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/UNIQUE|constraint|duplicate/i.test(msg)) return errRes(409, 'id already exists');
        return errRes(500, msg);
      }
    }
    return notFound;
  }

  if (pathname.startsWith(PREFIX + '/')) {
    const rawId = pathname.slice(PREFIX.length + 1);
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return errRes(400, 'invalid id encoding');
    }
    if (!id || id.includes('/')) return notFound;
    if (method === 'DELETE') {
      if (!findById(id)) return notFound;
      remove(id);
      return { status: 200, body: { ok: true } };
    }
    return notFound;
  }

  return null;
}
