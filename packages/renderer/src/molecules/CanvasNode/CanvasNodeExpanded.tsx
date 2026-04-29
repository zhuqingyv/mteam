import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Button from '../../atoms/Button';
import Icon from '../../atoms/Icon';
import StatusDot from '../../atoms/StatusDot';
import Avatar from '../Avatar';
import CanvasNodeChatBody from './CanvasNodeChatBody';
import { resolveNodeZ } from '../../utils/zIndex';
import './CanvasNodeExpanded.css';

type NodeStatus = 'idle' | 'thinking' | 'responding' | 'offline';

const DOT_MAP: Record<NodeStatus, 'online' | 'thinking' | 'responding' | 'offline'> = {
  idle: 'online',
  thinking: 'thinking',
  responding: 'responding',
  offline: 'offline',
};

export function getExpandedClassName(input: { dragging?: boolean }): string {
  const cls = ['canvas-node', 'canvas-node--expanded'];
  if (input.dragging) cls.push('canvas-node--dragging');
  return cls.join(' ');
}

export interface CanvasNodeExpandedProps {
  id: string;
  name: string;
  status: NodeStatus;
  /** 画布 viewport 内的 absolute 坐标（通常 = 收起态节点位置） */
  x: number;
  y: number;
  focused?: boolean;
  /** 顶栏拖动结束时回调新位置（已除以 zoom） */
  onDragEnd?: (x: number, y: number) => void;
  /** 读取当前画布缩放，用于把屏幕像素位移换算成 viewport 内位移 */
  getZoom?: () => number;
  onMinimize?: () => void;
  onClose?: () => void;
  teamId?: string | null;
  userName?: string;
  children?: ReactNode;
}

export default function CanvasNodeExpanded({
  id,
  name,
  status,
  x,
  y,
  focused = false,
  onDragEnd,
  getZoom,
  onMinimize,
  onClose,
  teamId = null,
  userName,
  children,
}: CanvasNodeExpandedProps) {
  const [pos, setPos] = useState({ x, y });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);

  // 父层 x/y 变化（比如外部重置位置）同步到内部
  const propKey = `${x},${y}`;
  const lastPropKey = useRef(propKey);
  if (lastPropKey.current !== propKey && !dragRef.current) {
    lastPropKey.current = propKey;
    if (pos.x !== x || pos.y !== y) setPos({ x, y });
  }

  const onHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y };
      setDragging(true);

      const scale = () => (getZoom ? getZoom() : 1) || 1;

      const move = (ev: MouseEvent) => {
        const s = dragRef.current;
        if (!s) return;
        const z = scale();
        const nx = s.px + (ev.clientX - s.mx) / z;
        const ny = s.py + (ev.clientY - s.my) / z;
        setPos({ x: nx, y: ny });
      };

      const up = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        const s = dragRef.current;
        dragRef.current = null;
        setDragging(false);
        if (!s) return;
        const z = scale();
        const nx = s.px + (ev.clientX - s.mx) / z;
        const ny = s.py + (ev.clientY - s.my) / z;
        onDragEnd?.(nx, ny);
      };

      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [pos.x, pos.y, getZoom, onDragEnd],
  );

  const zIndex = resolveNodeZ({ expanded: true, focused, dragging });

  return (
    <div
      className={getExpandedClassName({ dragging })}
      data-id={id}
      data-instance-id={id}
      data-status={status}
      style={{ left: pos.x, top: pos.y, zIndex }}
    >
      <div
        className="canvas-node__header"
        onMouseDown={onHeaderMouseDown}
      >
        <Avatar online={status !== 'offline'} size={24} />
        <span className="canvas-node__name" title={name}>{name}</span>
        <StatusDot status={DOT_MAP[status]} size="sm" />
        <div className="canvas-node__actions">
          {onMinimize && (
            <Button variant="icon" size="sm" onClick={onMinimize}>
              <Icon name="chevron-down" size={16} />
            </Button>
          )}
          {onClose && (
            <Button variant="icon" size="sm" onClick={onClose}>
              <Icon name="close" size={16} />
            </Button>
          )}
        </div>
      </div>
      <div className="canvas-node__body">
        {children ?? (
          <CanvasNodeChatBody instanceId={id} teamId={teamId} userName={userName} />
        )}
      </div>
    </div>
  );
}
