// ClaudeAdapter —— 适配 @agentclientprotocol/claude-agent-acp。
// - prompt 注入：_meta.systemPrompt = { append: <prompt> }（追加到 claude_code preset）。
// - MCP 注入：直接走 session/new.mcpServers 标准字段，driver.ts 统一处理。
// - parseUpdate 覆盖 ACP 11 种 sessionUpdate（含 user_message_chunk 但暂不映射）。
//   合约见 docs/phase-ws/turn-aggregator-design.md §3.2。
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter } from './adapter.js';
import type { LaunchSpec } from '../../process-runtime/types.js';
import type { DriverConfig, DriverEvent } from '../types.js';
import {
  compactAcpContent,
  extractContentText,
  mapToolKind,
  mapToolStatus,
  normalizeCommands,
  normalizeConfigOptions,
  normalizeLocations,
  normalizePlanEntries,
  normalizeToolInput,
  normalizeToolOutput,
} from '../normalize.js';

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export class ClaudeAdapter implements AgentAdapter {
  prepareLaunch(config: DriverConfig): LaunchSpec {
    const acpEntry = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
    );
    return {
      runtime: 'host',
      command: process.execPath,
      args: [acpEntry],
      env: { ...(config.env ?? {}) },
      cwd: config.cwd,
    };
  }

  sessionParams(config: DriverConfig): Record<string, unknown> {
    if (!config.systemPrompt) return {};
    return {
      _meta: { systemPrompt: { append: config.systemPrompt } },
    };
  }

  parseUpdate(update: unknown): DriverEvent | null {
    if (!update || typeof update !== 'object') return null;
    const u = update as Obj;
    switch (u.sessionUpdate) {
      case 'agent_thought_chunk': {
        const ev: DriverEvent = { type: 'driver.thinking', content: extractContentText(u.content) };
        const mid = str(u.messageId);
        if (mid) ev.messageId = mid;
        return ev;
      }
      case 'agent_message_chunk': {
        const ev: DriverEvent = { type: 'driver.text', content: extractContentText(u.content) };
        const mid = str(u.messageId);
        if (mid) ev.messageId = mid;
        return ev;
      }
      case 'tool_call': {
        const id = str(u.toolCallId);
        if (!id) return null;
        const title = str(u.title) ?? '';
        const ev: DriverEvent = {
          type: 'driver.tool_call',
          toolCallId: id,
          name: title || 'tool', // 过渡期老字段；types.ts 标 @deprecated
          title,
          status: mapToolStatus(u.status ?? 'pending'),
          input: normalizeToolInput('claude', title, u.rawInput),
        };
        const kind = mapToolKind(u.kind);
        if (kind) ev.kind = kind;
        const locs = normalizeLocations(u.locations);
        if (locs) ev.locations = locs;
        const content = compactAcpContent(u.content);
        if (content.length > 0) ev.content = content;
        return ev;
      }
      case 'tool_call_update': {
        const id = str(u.toolCallId);
        if (!id) return null;
        const ev: DriverEvent = { type: 'driver.tool_update', toolCallId: id };
        if (typeof u.status === 'string') ev.status = mapToolStatus(u.status);
        const title = str(u.title);
        if (title) ev.title = title;
        const kind = mapToolKind(u.kind);
        if (kind) ev.kind = kind;
        const locs = normalizeLocations(u.locations);
        if (locs) ev.locations = locs;
        if (u.rawOutput !== undefined) ev.output = normalizeToolOutput('claude', u.rawOutput);
        if (Array.isArray(u.content)) ev.content = compactAcpContent(u.content);
        return ev;
      }
      case 'plan':
        return { type: 'driver.plan', entries: normalizePlanEntries(u.entries) };
      case 'available_commands_update':
        return { type: 'driver.commands', commands: normalizeCommands(u.availableCommands) };
      case 'current_mode_update': {
        const id = str(u.currentModeId);
        return id ? { type: 'driver.mode', currentModeId: id } : null;
      }
      case 'config_option_update':
        return { type: 'driver.config', options: normalizeConfigOptions(u.configOptions) };
      case 'session_info_update': {
        const ev: DriverEvent = { type: 'driver.session_info' };
        const title = str(u.title);
        if (title) ev.title = title;
        const updatedAt = str(u.updatedAt);
        if (updatedAt) ev.updatedAt = updatedAt;
        return ev;
      }
      case 'usage_update': {
        const used = num(u.used);
        const size = num(u.size);
        if (used === undefined || size === undefined) return null;
        const ev: DriverEvent = { type: 'driver.usage', used, size };
        const cost = u.cost;
        if (cost && typeof cost === 'object') {
          const c = cost as Obj;
          const amount = num(c.amount);
          const currency = str(c.currency);
          if (amount !== undefined && currency) ev.cost = { amount, currency };
        }
        return ev;
      }
      // user_message_chunk：两家实测不发，暂不映射（设计 §2.3）
      default:
        return null;
    }
  }

  cleanup(): void {
    // Claude 不落盘，无需清理。
  }

  listTempFiles(): string[] {
    return [];
  }
}
