// Primary Agent HTTP 接口：配置 / 查询 / 启停。
// - GET  /api/primary-agent          未配置返回 200 + null
// - POST /api/primary-agent/config   首次 configure 自动生成 id，之后 upsert
// - POST /api/primary-agent/start    已在跑回 409
// - POST /api/primary-agent/stop     没在跑回 409
import { primaryAgent } from '../../primary-agent/primary-agent.js';
import type { PrimaryAgentConfig } from '../../primary-agent/types.js';
import type { McpToolVisibility } from '../../domain/role-template.js';
import type { ApiResponse } from './role-templates.js';

const errRes = (status: number, error: string): ApiResponse => ({ status, body: { error } });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateMcpConfig(v: unknown): McpToolVisibility[] | string {
  if (!Array.isArray(v)) return 'mcpConfig must be an array';
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (!isPlainObject(item)) return `mcpConfig[${i}] must be an object`;
    if (typeof item.serverName !== 'string' || item.serverName.length === 0) {
      return `mcpConfig[${i}].serverName must be a non-empty string`;
    }
    if (item.mode !== 'all' && item.mode !== 'whitelist') {
      return `mcpConfig[${i}].mode must be 'all' | 'whitelist'`;
    }
    if (item.mode === 'whitelist') {
      if (!Array.isArray(item.tools)) return `mcpConfig[${i}].tools must be array in whitelist mode`;
      for (const t of item.tools as unknown[]) {
        if (typeof t !== 'string') return `mcpConfig[${i}].tools must be string[]`;
      }
    }
  }
  return v as McpToolVisibility[];
}

export function handleGetPrimaryAgent(): ApiResponse {
  const row = primaryAgent.getConfig();
  return { status: 200, body: row };
}

export async function handleConfigurePrimaryAgent(body: unknown): Promise<ApiResponse> {
  if (!isPlainObject(body)) return errRes(400, 'body must be a JSON object');

  const config: PrimaryAgentConfig = {};

  if ('name' in body) {
    if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 64) {
      return errRes(400, 'name must be a string of 1~64 chars');
    }
    config.name = body.name;
  }

  if ('cliType' in body) {
    if (typeof body.cliType !== 'string' || body.cliType.length === 0) {
      return errRes(400, 'cliType must be a non-empty string');
    }
    config.cliType = body.cliType;
  }

  if ('systemPrompt' in body) {
    if (typeof body.systemPrompt !== 'string') {
      return errRes(400, 'systemPrompt must be a string');
    }
    config.systemPrompt = body.systemPrompt;
  }

  if ('mcpConfig' in body) {
    const parsed = validateMcpConfig(body.mcpConfig);
    if (typeof parsed === 'string') return errRes(400, parsed);
    config.mcpConfig = parsed;
  }

  try {
    const row = await primaryAgent.configure(config);
    return { status: 200, body: row };
  } catch (e) {
    return errRes(400, (e as Error).message);
  }
}

export async function handleStartPrimaryAgent(): Promise<ApiResponse> {
  if (primaryAgent.isRunning()) {
    return errRes(409, 'primary agent already running');
  }
  try {
    const row = await primaryAgent.start();
    return { status: 200, body: row };
  } catch (e) {
    return errRes(400, (e as Error).message);
  }
}

export async function handleStopPrimaryAgent(): Promise<ApiResponse> {
  if (!primaryAgent.isRunning()) {
    return errRes(409, 'primary agent is not running');
  }
  await primaryAgent.stop();
  const row = primaryAgent.getConfig();
  return { status: 200, body: row };
}
