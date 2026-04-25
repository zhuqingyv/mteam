// API 层统一出口。
//
// 硬门禁提示：前端只能走 /api/panel/*（PRD §0.2）。当前唯一真实可用接口是
// driver-turns（./driver-turns）；teams / instances / sessions / mcp 四个领域
// 返回 D6 pending 占位，facade 层落地后再补真调。WebSocket 走 /ws/events。

export {
  API_BASE,
  PANEL_BASE,
  panelGet,
  panelPost,
  panelPut,
  panelDelete,
  panelPending,
  type ApiResult,
} from './client';

export * from './driver-turns';
export * from './teams';
export * from './instances';
export * from './sessions';
export * from './mcp';
export * from './ws';
