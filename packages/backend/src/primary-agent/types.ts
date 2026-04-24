import type { McpToolVisibility } from '../domain/role-template.js';

export interface PrimaryAgentRow {
  id: string;
  name: string;
  cliType: string;
  systemPrompt: string;
  mcpConfig: McpToolVisibility[];
  status: 'STOPPED' | 'RUNNING';
  createdAt: string;
  updatedAt: string;
}

export interface PrimaryAgentConfig {
  name?: string;
  cliType?: string;
  systemPrompt?: string;
  mcpConfig?: McpToolVisibility[];
}
