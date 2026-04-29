import { useEffect, useRef, useState } from 'react';
import AgentLogo from '../../atoms/AgentLogo';
import StatusDot from '../../atoms/StatusDot';
import Avatar from '../Avatar';
import { clampNodePosition } from '../../utils/canvasClamp';
import { resolveNodeZ } from '../../utils/zIndex';
import './CanvasNode.css';

export type CanvasNodeStatus = 'idle' | 'thinking' | 'responding' | 'offline';

export interface CanvasNodeProps {
  id: string;
  name: string;
  status: CanvasNodeStatus;
  cliType?: string;
  /** 成员头像 URL；null/undefined → Avatar 组件兜底 Logo */
  avatar?: string | null;
  isLeader?: boolean;
  taskCount?: number;
  unreadCount?: number;
  messageCount?: number;
  x?: number;
  y?: number;
  /** 画布尺寸；传入后 onDragEnd 前套 clampNodePosition，越界回弹 150ms */
  canvasSize?: { width: number; height: number };
  clampPadding?: number;
  onOpen?: (id: string) => void;
  onDragEnd?: (x: number, y: number) => void;
  getZoom?: () => number;
  elementRef?: (el: HTMLDivElement | null) => void;
}

const DOT: Record<CanvasNodeStatus, 'online' | 'thinking' | 'responding' | 'offline'> = {
  idle: 'online',
  thinking: 'thinking',
  responding: 'responding',
  offline: 'offline',
};

export const DRAG_THRESHOLD = 3;

// 指针位移是否越过拖拽阈值。未越过 = 视为点击。
export function exceedsDragThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  return Math.hypot(dx, dy) > threshold;
}

export function getCanvasNodeClassName(input: { dragging?: boolean; isLeader?: boolean; rebounding?: boolean }): string {
  const cls = ['canvas-node', 'canvas-node--collapsed'];
  if (input.dragging) cls.push('canvas-node--dragging');
  if (input.isLeader) cls.push('canvas-node--leader');
  if (input.rebounding) cls.push('canvas-node--rebounding');
  return cls.join(' ');
}

export default function CanvasNode({
  id,
  name,
  status,
  cliType,
  avatar = null,
  isLeader = false,
  taskCount = 0,
  unreadCount = 0,
  messageCount = 0,
  x = 0,
  y = 0,
  canvasSize,
  clampPadding = 40,
  onOpen,
  onDragEnd,
  getZoom,
  elementRef,
}: CanvasNodeProps) {
  const [pos, setPos] = useState({ x, y });
  const [dragging, setDragging] = useState(false);
  const [rebounding, setRebounding] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ mx: number; my: number; px: number; py: number; moved: boolean } | null>(null);
  const reboundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setPos({ x, y }); }, [x, y]);
  useEffect(() => () => {
    if (reboundTimerRef.current) clearTimeout(reboundTimerRef.current);
  }, []);

  const setRoot = (el: HTMLDivElement | null) => {
    rootRef.current = el;
    elementRef?.(el);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (status === 'offline') return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y, moved: false };

    const scale = () => (getZoom ? getZoom() : 1) || 1;

    const move = (ev: MouseEvent) => {
      const s = dragRef.current;
      if (!s) return;
      const z = scale();
      const dx = (ev.clientX - s.mx) / z;
      const dy = (ev.clientY - s.my) / z;
      if (!s.moved && exceedsDragThreshold(dx, dy)) {
        s.moved = true;
        setDragging(true);
      }
      if (s.moved) setPos({ x: s.px + dx, y: s.py + dy });
    };

    const up = (ev: MouseEvent) => {
      const s = dragRef.current;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (s?.moved) {
        const z = scale();
        const rawX = s.px + (ev.clientX - s.mx) / z;
        const rawY = s.py + (ev.clientY - s.my) / z;
        setDragging(false);

        // S5-G2：canvasSize 已知则 clamp；越界触发 150ms 回弹
        let fx = rawX;
        let fy = rawY;
        if (canvasSize && rootRef.current) {
          const r = rootRef.current.getBoundingClientRect();
          const z2 = scale();
          const nodeSize = { width: r.width / z2, height: r.height / z2 };
          const clamped = clampNodePosition({ x: rawX, y: rawY }, nodeSize, canvasSize, clampPadding);
          fx = clamped.x;
          fy = clamped.y;
          if (clamped.clampedDir) {
            setRebounding(true);
            setPos({ x: fx, y: fy });
            if (reboundTimerRef.current) clearTimeout(reboundTimerRef.current);
            reboundTimerRef.current = setTimeout(() => setRebounding(false), 150);
          }
        }
        onDragEnd?.(fx, fy);
      } else {
        onOpen?.(id);
      }
      dragRef.current = null;
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const className = getCanvasNodeClassName({ dragging, isLeader, rebounding });
  const showMeta = taskCount > 0 || messageCount > 0;
  const zIndex = resolveNodeZ({ dragging });

  return (
    <div
      ref={setRoot}
      className={className}
      data-id={id}
      data-instance-id={id}
      data-status={status}
      style={{ left: pos.x, top: pos.y, zIndex }}
      onMouseDown={onMouseDown}
    >
      <div className="canvas-node__head">
        <Avatar
          src={avatar ?? undefined}
          size={36}
          alt={name}
          badge={cliType ? <AgentLogo cliType={cliType} size={16} grayscale={status === 'offline'} /> : undefined}
        />
        <div className="canvas-node__head-main">
          <div className="canvas-node__head-top">
            <StatusDot status={DOT[status]} size="sm" />
            <span className="canvas-node__name" title={name}>{name}</span>
            {unreadCount > 0 && (
              <span className="canvas-node__unread" aria-label={`${unreadCount} unread`}>
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </div>
          {showMeta && (
            <div className="canvas-node__meta">
              {taskCount > 0 && <span className="canvas-node__metric">{taskCount} 任务</span>}
              {messageCount > 0 && <span className="canvas-node__metric">{messageCount} 消息</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
