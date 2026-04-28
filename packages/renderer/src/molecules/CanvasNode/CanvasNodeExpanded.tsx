import { useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import Button from '../../atoms/Button';
import Icon from '../../atoms/Icon';
import StatusDot from '../../atoms/StatusDot';
import Avatar from '../Avatar';
import './CanvasNodeExpanded.css';

type NodeStatus = 'idle' | 'thinking' | 'responding' | 'offline';

const DOT_MAP: Record<NodeStatus, 'online' | 'thinking' | 'responding' | 'offline'> = {
  idle: 'online',
  thinking: 'thinking',
  responding: 'responding',
  offline: 'offline',
};

export interface CanvasNodeExpandedProps {
  id: string;
  name: string;
  status: NodeStatus;
  onMinimize?: () => void;
  onClose?: () => void;
  onDragHeader?: (dx: number, dy: number) => void;
  children?: ReactNode;
}

export default function CanvasNodeExpanded({
  id,
  name,
  status,
  onMinimize,
  onClose,
  onDragHeader,
  children,
}: CanvasNodeExpandedProps) {
  const dragRef = useRef<{ mx: number; my: number } | null>(null);

  const onHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!onDragHeader) return;
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      dragRef.current = { mx: e.clientX, my: e.clientY };
      const move = (ev: MouseEvent) => {
        const s = dragRef.current;
        if (!s) return;
        const dx = ev.clientX - s.mx;
        const dy = ev.clientY - s.my;
        s.mx = ev.clientX;
        s.my = ev.clientY;
        onDragHeader(dx, dy);
      };
      const up = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [onDragHeader],
  );

  return (
    <div
      className="canvas-node canvas-node--expanded"
      data-id={id}
      data-status={status}
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
      <div className="canvas-node__body">{children}</div>
    </div>
  );
}
