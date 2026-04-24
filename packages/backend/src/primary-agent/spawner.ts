import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { cliManager } from '../cli-scanner/manager.js';
import { mcpManager } from '../mcp-store/mcp-manager.js';
import type { McpToolVisibility } from '../domain/role-template.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

export interface SpawnInput {
  agentId: string;
  name: string;
  cliType: string;
  systemPrompt: string;
  mcpConfig: McpToolVisibility[];
}

export interface SpawnResult {
  handle: IPty;
  mcpConfigPath: string;
  commSock: string;
  selfAddress: string;
}

export function defaultCommSock(): string {
  return (
    process.env.TEAM_HUB_COMM_SOCK ??
    join(homedir(), '.claude', 'team-hub', 'comm.sock')
  );
}

function defaultHubUrl(): string {
  return `http://localhost:${process.env.V2_PORT ?? '58590'}`;
}

export function spawnPrimaryCli(input: SpawnInput): SpawnResult {
  const commSock = defaultCommSock();
  const hubUrl = defaultHubUrl();
  const selfAddress = `local:${input.agentId}`;

  const resolved = mcpManager.resolve(input.mcpConfig, {
    instanceId: input.agentId,
    hubUrl,
    commSock,
    isLeader: true,
  });
  for (const name of resolved.skipped) {
    process.stderr.write(`[primary-agent] mcp '${name}' not found in store, skip\n`);
  }

  const mcpConfigPath = join(tmpdir(), `mteam-primary-${input.agentId}.json`);
  writeFileSync(mcpConfigPath, JSON.stringify(resolved.configJson), 'utf-8');

  const cliBin = cliManager.getInfo(input.cliType)?.path ?? input.cliType;
  const cliArgs = [
    '--mcp-config', mcpConfigPath,
    '--append-system-prompt', input.systemPrompt,
    '--dangerously-skip-permissions',
  ];
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ROLE_INSTANCE_ID: input.agentId,
    CLAUDE_MEMBER: input.name,
    IS_LEADER: '1',
    TEAM_HUB_NO_LAUNCH: '1',
    TERM: process.env.TERM ?? 'xterm-256color',
  };

  const handle = ptySpawn(cliBin, cliArgs, {
    name: 'xterm-256color',
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd: process.cwd(),
    env,
  });

  return { handle, mcpConfigPath, commSock, selfAddress };
}

export function removeMcpConfig(path: string | null): void {
  if (!path) return;
  try { unlinkSync(path); } catch { /* ignore */ }
}
