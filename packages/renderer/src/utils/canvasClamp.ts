// S5-M1 clampNodePosition —— 把节点位置夹回画布内。
// 纯函数：不依赖 DOM / store；输入一组坐标+尺寸+边距，返回被夹回的新坐标。

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type ClampedDir = 'n' | 's' | 'e' | 'w' | null;

export interface ClampResult extends Point {
  clampedDir: ClampedDir;
}

/**
 * 把节点位置夹回画布内。
 * - pos 是节点**左上角**在画布坐标系下的位置。
 * - 可用区域 = [padding, canvas - node - padding]。
 * - 若画布 < node+2*padding（极小画布），居中对齐，clampedDir=null。
 * - clampedDir 返回第一条被触发的边；多边越界时记录 y 方向（n/s）优先。
 */
export function clampNodePosition(
  pos: Point,
  nodeSize: Size,
  canvasSize: Size,
  padding = 40,
): ClampResult {
  const maxX = canvasSize.width - nodeSize.width - padding;
  const maxY = canvasSize.height - nodeSize.height - padding;
  const minX = padding;
  const minY = padding;

  // 画布太小：居中对齐，不再 clamp 方向
  if (maxX < minX || maxY < minY) {
    return {
      x: Math.max(0, (canvasSize.width - nodeSize.width) / 2),
      y: Math.max(0, (canvasSize.height - nodeSize.height) / 2),
      clampedDir: null,
    };
  }

  let x = pos.x;
  let y = pos.y;
  let dir: ClampedDir = null;

  if (y < minY) { y = minY; dir = 'n'; }
  else if (y > maxY) { y = maxY; dir = 's'; }

  if (x < minX) { x = minX; if (!dir) dir = 'w'; }
  else if (x > maxX) { x = maxX; if (!dir) dir = 'e'; }

  return { x, y, clampedDir: dir };
}
