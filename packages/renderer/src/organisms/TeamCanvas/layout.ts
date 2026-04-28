export interface LayoutAgent {
  id: string;
  isLeader?: boolean;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export type Position = { x: number; y: number };
export type PositionMap = Record<string, Position>;

const CARD_W = 180;
const CARD_H = 64;
const LEADER_OFFSET_Y_RATIO = 0.08;
const RING_RADIUS_RATIO = 0.28;
const RING_RADIUS_MIN = 160;
const TWO_PI = Math.PI * 2;

function leaderPos(size: CanvasSize): Position {
  return {
    x: size.width / 2 - CARD_W / 2,
    y: size.height / 2 - CARD_H / 2 - size.height * LEADER_OFFSET_Y_RATIO,
  };
}

function ringRadius(size: CanvasSize): number {
  return Math.max(RING_RADIUS_MIN, Math.min(size.width, size.height) * RING_RADIUS_RATIO);
}

function polarToCartesian(center: Position, radius: number, angle: number): Position {
  return {
    x: center.x + Math.cos(angle) * radius - CARD_W / 2,
    y: center.y + Math.sin(angle) * radius - CARD_H / 2,
  };
}

export function computeLayout(
  agents: LayoutAgent[],
  size: CanvasSize,
  savedPositions: PositionMap = {},
): PositionMap {
  const out: PositionMap = {};
  if (agents.length === 0) return out;

  const leader = agents.find((a) => a.isLeader) ?? agents[0];
  const members = agents.filter((a) => a.id !== leader.id);

  out[leader.id] = savedPositions[leader.id] ?? leaderPos(size);

  const center: Position = {
    x: size.width / 2,
    y: size.height / 2 - size.height * LEADER_OFFSET_Y_RATIO + CARD_H / 2,
  };
  const radius = ringRadius(size);
  const slotCount = Math.max(members.length, 1);
  const step = TWO_PI / slotCount;

  const taken = new Set<number>();
  const unplaced: LayoutAgent[] = [];
  for (const m of members) {
    if (savedPositions[m.id]) {
      out[m.id] = savedPositions[m.id];
    } else {
      unplaced.push(m);
    }
  }

  let cursor = 0;
  for (const m of unplaced) {
    while (taken.has(cursor)) cursor = (cursor + 1) % slotCount;
    const angle = Math.PI / 2 + cursor * step;
    out[m.id] = polarToCartesian(center, radius, angle);
    taken.add(cursor);
    cursor = (cursor + 1) % slotCount;
  }

  return out;
}
