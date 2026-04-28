import { describe, it, expect } from 'bun:test';
import { buildPrimaryAgentSnapshot } from './snapshot-builder.js';
import type { PrimaryAgentRow } from '../primary-agent/types.js';

describe('buildPrimaryAgentSnapshot', () => {
  it('row=null → primaryAgent:null', () => {
    expect(buildPrimaryAgentSnapshot(null)).toEqual({
      type: 'snapshot',
      primaryAgent: null,
    });
  });

  it('RUNNING row → 引用相等透传', () => {
    const row: PrimaryAgentRow = {
      id: 'p1',
      name: 'MTEAM',
      cliType: 'claude',
      systemPrompt: '',
      mcpConfig: [],
      status: 'RUNNING',
      sandbox: true,
      permissionMode: 'auto',
      createdAt: '2026-04-25T00:00:00Z',
      updatedAt: '2026-04-25T00:00:00Z',
    };
    const snap = buildPrimaryAgentSnapshot(row);
    expect(snap.type).toBe('snapshot');
    expect(snap.primaryAgent).toBe(row);
  });

  it('STOPPED row → 引用相等透传', () => {
    const row: PrimaryAgentRow = {
      id: 'p2',
      name: 'MTEAM',
      cliType: 'codex',
      systemPrompt: 'sys',
      mcpConfig: [],
      status: 'STOPPED',
      sandbox: true,
      permissionMode: 'auto',
      createdAt: '2026-04-25T00:00:00Z',
      updatedAt: '2026-04-25T00:00:00Z',
    };
    const snap = buildPrimaryAgentSnapshot(row);
    expect(snap.primaryAgent).toBe(row);
  });

  it('mcpConfig 非空数组原样透传', () => {
    const row: PrimaryAgentRow = {
      id: 'p3',
      name: 'MTEAM',
      cliType: 'claude',
      systemPrompt: '',
      mcpConfig: [
        { name: 'mnemo', surface: '*', search: '*' },
      ],
      status: 'RUNNING',
      sandbox: true,
      permissionMode: 'auto',
      createdAt: '2026-04-25T00:00:00Z',
      updatedAt: '2026-04-25T00:00:00Z',
    };
    const snap = buildPrimaryAgentSnapshot(row);
    expect(snap.primaryAgent).toEqual(row);
    expect(snap.primaryAgent!.mcpConfig).toBe(row.mcpConfig);
  });
});
