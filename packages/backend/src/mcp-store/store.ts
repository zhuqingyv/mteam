import {
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpConfig } from './types.js';

const STORE_DIR = join(homedir(), '.claude', 'team-hub', 'mcp-store');

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }
}

function filePath(name: string): string {
  return join(STORE_DIR, `${name}.json`);
}

function parseFile(path: string): McpConfig | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as McpConfig;
  } catch {
    return null;
  }
}

export function listAll(): McpConfig[] {
  ensureDir();
  const entries = readdirSync(STORE_DIR);
  const result: McpConfig[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const cfg = parseFile(join(STORE_DIR, entry));
    if (cfg) result.push(cfg);
  }
  return result;
}

export function findByName(name: string): McpConfig | null {
  ensureDir();
  const path = filePath(name);
  if (!existsSync(path)) return null;
  return parseFile(path);
}

export function install(config: Omit<McpConfig, 'builtin'> & { builtin?: boolean }): McpConfig {
  ensureDir();
  const final: McpConfig = {
    name: config.name,
    displayName: config.displayName,
    description: config.description,
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? {},
    transport: config.transport ?? 'stdio',
    builtin: false,
  };
  writeFileSync(filePath(final.name), JSON.stringify(final, null, 2), 'utf-8');
  return final;
}

export function uninstall(name: string): void {
  ensureDir();
  const existing = findByName(name);
  if (!existing) {
    const err = new Error(`mcp '${name}' not found`);
    (err as Error & { code?: string }).code = 'NOT_FOUND';
    throw err;
  }
  if (existing.builtin) {
    const err = new Error(`mcp '${name}' is builtin and cannot be uninstalled`);
    (err as Error & { code?: string }).code = 'BUILTIN';
    throw err;
  }
  unlinkSync(filePath(name));
}

export function ensureDefaults(): void {
  ensureDir();
  const mteamPath = filePath('mteam');
  if (existsSync(mteamPath)) return;
  const mteam: McpConfig = {
    name: 'mteam',
    displayName: 'Team Hub',
    description: '内置团队协作工具',
    command: '__builtin__',
    args: [],
    env: {},
    transport: 'stdio',
    builtin: true,
  };
  writeFileSync(mteamPath, JSON.stringify(mteam, null, 2), 'utf-8');
}
