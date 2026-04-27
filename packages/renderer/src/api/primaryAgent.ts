// Primary Agent —— /api/panel/primary-agent* facade。
//
// 状态路径已改为全走 WS（snapshot + primary_agent.* 事件）。本文件的函数
// 不再被前端常规流程调用：getPrimaryAgent 仅作调试备用，configurePrimaryAgent
// 仅作 mcpConfig 场景的备用入口（WS 的 configure_primary_agent 不支持 mcpConfig）。
// 模块 2 规约：状态不得走 HTTP，修改时请确保替代路径依然是 WS。

import { panelGet, panelPost, type ApiResult } from './client';

export interface PaMcpToolVisibility {
  serverName: string;
  mode: 'all' | 'whitelist';
  tools?: string[];
}

export type AgentState = 'idle' | 'thinking' | 'responding';

export interface PrimaryAgentRow {
  id: string;
  name: string;
  cliType: string;
  systemPrompt: string;
  mcpConfig: PaMcpToolVisibility[];
  status: 'STOPPED' | 'RUNNING';
  // 工作状态：snapshot + primary_agent.state_changed 都会携带。
  // idle=空闲 thinking=思考(UI 显 loading) responding=回复中(流式渲染)
  agentState?: AgentState;
  createdAt: string;
  updatedAt: string;
}

export interface PrimaryAgentConfig {
  name?: string;
  cliType?: string;
  systemPrompt?: string;
  mcpConfig?: PaMcpToolVisibility[];
}

/** @deprecated 主 Agent 状态全走 WS（snapshot + primary_agent.* 事件），仅留此函数做调试。 */
export function getPrimaryAgent(): Promise<ApiResult<PrimaryAgentRow | null>> {
  return panelGet<PrimaryAgentRow | null>('/primary-agent');
}

/**
 * @deprecated 常规 cliType/name/systemPrompt 请走 WS `configure_primary_agent`；
 * 仅当需要下发 mcpConfig（WS 不支持）时使用本函数。
 */
export function configurePrimaryAgent(
  body: PrimaryAgentConfig,
): Promise<ApiResult<PrimaryAgentRow>> {
  return panelPost<PrimaryAgentRow>('/primary-agent/config', body);
}
