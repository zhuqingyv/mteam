// process-runtime 跨 Stage 契约。
// 权威来源：docs/phase-sandbox-acp/INTERFACE-CONTRACTS.md §1-3。
// 不允许在实现层或其他文档里改名、加字段、改签名。

export type StdioMode = 'pipe' | 'inherit' | 'ignore';

export interface StdioConfig {
  stdin?: StdioMode;
  stdout?: StdioMode;
  stderr?: StdioMode;
}

export interface LaunchSpec {
  runtime: 'host' | 'docker';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdio?: StdioConfig;
}

export interface RuntimeHandle {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly pid: number | string;
  kill(signal?: string): Promise<void>;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
}

export interface ProcessRuntime {
  spawn(spec: LaunchSpec): Promise<RuntimeHandle>;
  isAvailable(cliType: string): Promise<boolean>;
  destroy(): Promise<void>;
}

const VALID_STDIO_MODES: ReadonlySet<string> = new Set(['pipe', 'inherit', 'ignore']);

function isStdioConfig(x: unknown): x is StdioConfig {
  if (x === undefined) return true;
  if (x === null || typeof x !== 'object') return false;
  const { stdin, stdout, stderr } = x as Record<string, unknown>;
  for (const v of [stdin, stdout, stderr]) {
    if (v !== undefined && (typeof v !== 'string' || !VALID_STDIO_MODES.has(v))) {
      return false;
    }
  }
  return true;
}

export function isLaunchSpec(x: unknown): x is LaunchSpec {
  if (x === null || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;

  if (o.runtime !== 'host' && o.runtime !== 'docker') return false;
  if (typeof o.command !== 'string' || o.command.length === 0) return false;
  if (!Array.isArray(o.args) || !o.args.every(a => typeof a === 'string')) return false;

  if (o.env === null || typeof o.env !== 'object' || Array.isArray(o.env)) return false;
  for (const v of Object.values(o.env as Record<string, unknown>)) {
    if (typeof v !== 'string') return false;
  }

  if (typeof o.cwd !== 'string' || o.cwd.length === 0) return false;

  if (!isStdioConfig(o.stdio)) return false;

  return true;
}
