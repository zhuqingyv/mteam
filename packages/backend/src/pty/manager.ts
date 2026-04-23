import { spawn as ptySpawn, type IPty } from 'node-pty';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemblePrompt } from './prompt.js';
import { findByName as findMcp } from '../mcp-store/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// mteam MCP 子进程入口路径（由 mteam-mcp/ 改名为 mcp/）
const MTEAM_MCP_ENTRY = join(__dirname, '..', 'mcp', 'index.js');

const READY_RE = /bypass permissions|shift\+tab/i;
const DEFAULT_BUFFER_BYTES = 64 * 1024;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const KILL_GRACE_MS = 2000;

export interface SpawnOptions {
  instanceId: string;
  memberName: string;
  isLeader: boolean;
  leaderName: string | null;
  task: string | null;
  persona: string | null;
  availableMcps?: string[];
  cols?: number;
  rows?: number;
  cwd?: string;
  cliBin?: string;
  hubUrl?: string;
}

export interface PtyEntry {
  instanceId: string;
  pid: number;
  handle: IPty;
  ready: boolean;
  spawnedAt: string;
  mcpConfigPath: string;
}

class RingBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    this.chunks.push(chunk);
    this.size += Buffer.byteLength(chunk, 'utf-8');
    while (this.size > this.max && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped) this.size -= Buffer.byteLength(dropped, 'utf-8');
    }
  }
  read(maxBytes?: number): string {
    const joined = this.chunks.join('');
    if (!maxBytes || Buffer.byteLength(joined, 'utf-8') <= maxBytes) return joined;
    return joined.slice(-maxBytes);
  }
}

export class PtyManager {
  private entries = new Map<string, PtyEntry>();
  private buffers = new Map<string, RingBuffer>();

  spawn(opts: SpawnOptions): PtyEntry {
    const prompt = assemblePrompt({
      memberName: opts.memberName,
      isLeader: opts.isLeader,
      leaderName: opts.leaderName,
      persona: opts.persona,
      task: opts.task,
    });
    const hubUrl = opts.hubUrl ?? `http://localhost:${process.env.V2_PORT ?? '58580'}`;
    const mcpConfigPath = join(tmpdir(), `mteam-${opts.instanceId}.json`);
    const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
    const names = opts.availableMcps ?? [];
    for (const name of names) {
      const cfg = findMcp(name);
      if (!cfg) {
        process.stderr.write(`[pty] mcp '${name}' not found in store, skip\n`);
        continue;
      }
      if (cfg.command === '__builtin__') {
        mcpServers[name] = {
          command: process.execPath,
          args: [MTEAM_MCP_ENTRY],
          env: {
            ROLE_INSTANCE_ID: opts.instanceId,
            V2_SERVER_URL: hubUrl,
            TEAM_HUB_COMM_SOCK: process.env.TEAM_HUB_COMM_SOCK ?? '',
          },
        };
      } else {
        mcpServers[name] = {
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
        };
      }
    }
    const mcpConfig = { mcpServers };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), 'utf-8');

    const cliBin = opts.cliBin ?? process.env.TEAM_HUB_CLI_BIN ?? 'claude';
    const cliArgs = [
      '--mcp-config', mcpConfigPath,
      '--append-system-prompt', prompt,
      '--dangerously-skip-permissions',
    ];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ROLE_INSTANCE_ID: opts.instanceId,
      CLAUDE_MEMBER: opts.memberName,
      IS_LEADER: opts.isLeader ? '1' : '0',
      TEAM_HUB_NO_LAUNCH: '1',
      TERM: process.env.TERM ?? 'xterm-256color',
    };

    const handle = ptySpawn(cliBin, cliArgs, {
      name: 'xterm-256color',
      cols: opts.cols ?? DEFAULT_COLS,
      rows: opts.rows ?? DEFAULT_ROWS,
      cwd: opts.cwd ?? process.cwd(),
      env,
    });
    process.stderr.write(`[pty] spawned ${cliBin} pid=${handle.pid} instance=${opts.instanceId}\n`);

    const buffer = new RingBuffer(DEFAULT_BUFFER_BYTES);
    const entry: PtyEntry = {
      instanceId: opts.instanceId,
      pid: handle.pid,
      handle,
      ready: false,
      spawnedAt: new Date().toISOString(),
      mcpConfigPath,
    };

    handle.onData((chunk) => {
      buffer.push(chunk);
      if (!entry.ready && READY_RE.test(chunk)) entry.ready = true;
    });
    handle.onExit(({ exitCode, signal }) => {
      process.stderr.write(
        `[pty] instance ${opts.instanceId} exited code=${exitCode} signal=${signal ?? 0}\n`,
      );
      this.cleanup(opts.instanceId);
    });

    this.entries.set(opts.instanceId, entry);
    this.buffers.set(opts.instanceId, buffer);
    return entry;
  }

  write(instanceId: string, data: string): void {
    const e = this.entries.get(instanceId);
    if (e) e.handle.write(data);
  }

  readBuffer(instanceId: string, maxBytes?: number): string {
    return this.buffers.get(instanceId)?.read(maxBytes) ?? '';
  }

  resize(instanceId: string, cols: number, rows: number): void {
    const e = this.entries.get(instanceId);
    if (e) {
      try { e.handle.resize(cols, rows); } catch { /* already exited */ }
    }
  }

  kill(instanceId: string): void {
    const entry = this.entries.get(instanceId);
    if (!entry) return;
    try { entry.handle.kill('SIGTERM'); } catch { /* already exited */ }
    const pid = entry.pid;
    setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }, KILL_GRACE_MS);
    this.cleanup(instanceId);
  }

  list(): PtyEntry[] {
    return Array.from(this.entries.values());
  }

  private cleanup(instanceId: string): void {
    const entry = this.entries.get(instanceId);
    if (entry) {
      try { unlinkSync(entry.mcpConfigPath); } catch { /* ignore */ }
    }
    this.entries.delete(instanceId);
    this.buffers.delete(instanceId);
  }
}

export const ptyManager = new PtyManager();
