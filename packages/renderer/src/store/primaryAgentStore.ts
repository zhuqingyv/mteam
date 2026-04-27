// 主 Agent 全状态 store。
//
// 设计要点：
// - 单一数据源：config（PrimaryAgentRow）+ instanceId（来自 config.id）。
// - 状态全走 WS：snapshot 初始化；primary_agent.* 事件直接 setState；不调 HTTP refresh。
// - driverLifecycle 由 WS driver 事件写入。
// - inflightAction 做按钮态/互斥；WS configure 的 ack 到达时清除。
// - configure 走 WS `configure_primary_agent`（仅支持 cliType/name/systemPrompt）。

import { create } from 'zustand';
import type { AgentState, PrimaryAgentRow } from '../api/primaryAgent';
import type { ConfigurePrimaryAgentBody } from '../api/ws';
import { useWsStore } from './wsStore';

export type PaStatus = 'STOPPED' | 'RUNNING';
export type DriverLifecycle = 'idle' | 'ready' | 'stopped' | 'error';
export type InflightAction = 'configure' | null;

export interface PrimaryAgentSnapshot {
  config: PrimaryAgentRow | null;
  status: PaStatus;
  // 总控工作状态：snapshot 和 primary_agent.state_changed 事件驱动；STOPPED 时视为 idle。
  agentState: AgentState;
  instanceId: string | null;
  driverLifecycle: DriverLifecycle;
  inflightAction: InflightAction;
  lastError: string | null;
}

interface PrimaryAgentActions {
  configure: (body: ConfigurePrimaryAgentBody) => void;
  reset: () => void;
}

type PrimaryAgentState = PrimaryAgentSnapshot & PrimaryAgentActions;

const INIT: PrimaryAgentSnapshot = {
  config: null,
  status: 'STOPPED',
  agentState: 'idle',
  instanceId: null,
  driverLifecycle: 'idle',
  inflightAction: null,
  lastError: null,
};

export const usePrimaryAgentStore = create<PrimaryAgentState>()((set) => ({
  ...INIT,

  configure: (body) => {
    const client = useWsStore.getState().client;
    if (!client) {
      set({ lastError: 'ws not connected' });
      return;
    }
    const requestId = `cfg-${Date.now()}`;
    pendingConfigureReqs.add(requestId);
    set({ inflightAction: 'configure', lastError: null });
    client.configurePrimaryAgent(body, requestId);
  },

  reset: () => set({ ...INIT }),
}));

// configure 的 ack 回到时清 inflight —— 由 wsEventHandlers/useWsEvents 的 onAck 调用。
const pendingConfigureReqs = new Set<string>();
export function handleConfigureAck(requestId: string, ok: boolean, reason?: string): void {
  if (!pendingConfigureReqs.delete(requestId)) return;
  usePrimaryAgentStore.setState(
    ok ? { inflightAction: null } : { inflightAction: null, lastError: reason ?? 'configure failed' },
  );
}

function mapDriverLifecycle(kind: string): DriverLifecycle | null {
  if (kind.endsWith('.ready')) return 'ready';
  if (kind.endsWith('.stopped') || kind.endsWith('.exited')) return 'stopped';
  if (kind.endsWith('.error') || kind.endsWith('.failed')) return 'error';
  return null;
}

// WS bridge —— 由 useWsEvents 调用，store 自身不订阅 ws。
// 只保留 driver.* → driverLifecycle 映射；primary_agent.* 直接在 wsEventHandlers 写 store。
export const primaryAgentBridge = {
  onDriverEvent(kind: string, driverId: string): void {
    const state = usePrimaryAgentStore.getState();
    if (state.instanceId == null) return;
    if (driverId !== state.instanceId) return;

    const next = mapDriverLifecycle(kind);
    if (next) usePrimaryAgentStore.setState({ driverLifecycle: next });
  },
};

export const selectOnline = (s: PrimaryAgentState) => s.status === 'RUNNING';
export const selectPaConfig = (s: PrimaryAgentState) => s.config;
export const selectPaInstanceId = (s: PrimaryAgentState) => s.instanceId;
export const selectInflight = (s: PrimaryAgentState) => s.inflightAction;
export const selectDriverLifecycle = (s: PrimaryAgentState) => s.driverLifecycle;
export const selectAgentState = (s: PrimaryAgentState) => s.agentState;
