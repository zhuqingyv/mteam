// S5-M2 zIndexResolver —— 画布层级统一口径。
//
// 约定：
//  Z.CANVAS_FX=1 触手 canvas
//  VIEWPORT=2    节点默认
//  NODE_DRAGGING=10
//  NODE_EXPANDED=20
//  NODE_EXPANDED_FOCUSED=30
//  Z.TOP_UI=40   CanvasTopBar / ZoomControl / MiniMap

export const Z = {
  CANVAS_FX: 1,
  VIEWPORT: 2,
  NODE_DRAGGING: 10,
  NODE_EXPANDED: 20,
  NODE_EXPANDED_FOCUSED: 30,
  TOP_UI: 40,
} as const;

export interface NodeZState {
  dragging?: boolean;
  expanded?: boolean;
  focused?: boolean;
}

/**
 * 计算节点 z-index。
 * 优先级（高→低）：focused+expanded > expanded > dragging > default。
 * focused 不搭配 expanded 时视同 default（非展开态不存在聚焦语义）。
 */
export function resolveNodeZ(s: NodeZState): number {
  if (s.expanded && s.focused) return Z.NODE_EXPANDED_FOCUSED;
  if (s.expanded) return Z.NODE_EXPANDED;
  if (s.dragging) return Z.NODE_DRAGGING;
  return Z.VIEWPORT;
}
