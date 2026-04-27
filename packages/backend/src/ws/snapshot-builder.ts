// Phase WS-Primary · W1-B：主 Agent snapshot 纯函数。
// 每次 WS 建连由 ws-upgrade 调一次，把 PrimaryAgentRow 透传成下行 snapshot。
// 零副作用、不碰 bus、不查 DB；行为等价 `GET /api/primary-agent`。
import type { PrimaryAgentRow } from '../primary-agent/types.js';
import type { WsSnapshot } from './protocol.js';

/** row 随 PrimaryAgentRow 结构扩张自动跟进；无需本模块同步修改。 */
export function buildPrimaryAgentSnapshot(
  row: PrimaryAgentRow | null,
): WsSnapshot {
  return { type: 'snapshot', primaryAgent: row };
}
