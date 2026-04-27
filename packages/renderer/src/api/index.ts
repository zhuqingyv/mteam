// API 层统一出口。
//
// 硬门禁：前端只走 /api/panel/*（PRD §0.2）。WebSocket 走 /ws/events。
// mcp.install / uninstall 的 panel 门面尚未开放，用 panelPending 占位。

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

export * from './cli';
export * from './driver-turn-history';
export * from './driver-turns';
export * from './instances';
export * from './mcp';
export * from './primaryAgent';
export * from './roster';
export * from './sessions';
export * from './teams';
export * from './templates';
export * from './ws';
