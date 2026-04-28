import { useEffect, useRef, useState } from 'react';
import AgentLogo from '../../atoms/AgentLogo';
import StatusDot from '../../atoms/StatusDot';
import './CanvasNode.css';

export type CanvasNodeStatus = 'idle' | 'thinking' | 'responding' | 'offline';

export interface CanvasNodeProps {
  id: string;
  name: string;
  status: CanvasNodeStatus;
  cliType?: string;
  avatar?: string | null;        // 成员头像图片 URL；空值走首字母兜底
  isLeader?: boolean;
  taskCount?: number;
  unreadCount?: number;
  messageCount?: number;
  x?: number;
  y?: number;
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

// 判断指针位移是否已经越过拖拽阈值。未越过 = 视为点击。
export function exceedsDragThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  return Math.hypot(dx, dy) > threshold;
}

export function getCanvasNodeClassName(input: { dragging?: boolean; isLeader?: boolean }): string {
  const cls = ['canvas-node', 'canvas-node--collapsed'];
  if (input.dragging) cls.push('canvas-node--dragging');
  if (input.isLeader) cls.push('canvas-node--leader');
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
  onOpen,
  onDragEnd,
  getZoom,
  elementRef,
}: CanvasNodeProps) {
  const [pos, setPos] = useState({ x, y });
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ mx: number; my: number; px: number; py: number; moved: boolean } | null>(null);

  useEffect(() => { setPos({ x, y }); }, [x, y]);

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
        const nx = s.px + (ev.clientX - s.mx) / z;
        const ny = s.py + (ev.clientY - s.my) / z;
        setDragging(false);
        onDragEnd?.(nx, ny);
      } else {
        onOpen?.(id);
      }
      dragRef.current = null;
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const className = getCanvasNodeClassName({ dragging, isLeader });

  const showMeta = taskCount > 0 || messageCount > 0;

  return (
    <div
      ref={setRoot}
      className={className}
      data-id={id}
      data-status={status}
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={onMouseDown}
    >
      <div className="canvas-node__head">
        <span className="canvas-node__avatar" aria-hidden>
          {avatar ? (
            <img src={avatar} alt="" className="canvas-node__avatar-img" />
          ) : (
            <span className="canvas-node__avatar-initial">
              {name.charAt(0).toUpperCase() || '?'}
            </span>
          )}
          {cliType && (
            <span className="canvas-node__avatar-badge">
              <AgentLogo cliType={cliType} size={14} grayscale={status === 'offline'} />
            </span>
          )}
        </span>
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
  );
}
