// API 层统一出口。
//
// 硬门禁提示：前端只能走 /api/panel/*（PRD §0.2）。teams / instances / sessions /
// mcp / driver-turns 已接 panel facade 真调；少数未暴露的端点仍用 panelPending 占位
// （teams.addMember / removeMember、sessions.list / get、mcp.install / uninstall）。
// WebSocket 走 /ws/events。

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
export * from './primaryAgent';
export * from './ws';
