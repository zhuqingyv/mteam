import { useCallback, useEffect, useRef, useState } from 'react';
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

export interface CanvasNodeExpandedProps {
  id: string;
  name: string;
  status: NodeStatus;
  onMinimize?: () => void;
  onClose?: () => void;
  onDragHeader?: (dx: number, dy: number) => void;
  // S5-G1 fixed 定位：锚点元素（父 CanvasNode 收起态 DOM）；不传时退回静态渲染
  anchorEl?: HTMLElement | null;
  expandedIndex?: number; // 同时展开多个时的顺序：偏移 24px * index
  focused?: boolean;      // 命中栈顶时 z-index=30，否则 20
  // canvas transform 变化的版本号：每次变化 bump 一次，expanded 观察后重算锚点
  transformEpoch?: number;
  // S4-G2a 装配参数：未传 children 时，主区自动渲染 ChatList + InstanceChatPanelConnected
  teamId?: string | null;
  userName?: string;
  children?: ReactNode;
}

interface AnchorPos {
  left: number;
  top: number;
}

// 纯函数：由锚点 rect + 视窗尺寸 + expandedIndex 推导 fixed 定位左上角
export function computeExpandedAnchor(
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  panelSize: { w: number; h: number },
  viewport: { w: number; h: number },
  expandedIndex = 0,
): AnchorPos {
  const offset = 24 * expandedIndex;
  // 优先放在收起节点右侧
  let left = rect.right + 12 + offset;
  let top = rect.top + offset;
  if (left + panelSize.w > viewport.w - 8) {
    // 右侧放不下 → 试左侧
    left = rect.left - panelSize.w - 12 - offset;
    if (left < 8) {
      // 也放不下 → 贴视窗右边缘
      left = Math.max(8, viewport.w - panelSize.w - 8);
    }
  }
  if (top + panelSize.h > viewport.h - 8) {
    top = Math.max(8, viewport.h - panelSize.h - 8);
  }
  if (top < 8) top = 8;
  return { left, top };
}

const PANEL_W = 420;
const PANEL_H = 540;

export default function CanvasNodeExpanded({
  id,
  name,
  status,
  onMinimize,
  onClose,
  onDragHeader,
  anchorEl = null,
  expandedIndex = 0,
  focused = false,
  transformEpoch = 0,
  teamId = null,
  userName,
  children,
}: CanvasNodeExpandedProps) {
  const dragRef = useRef<{ mx: number; my: number } | null>(null);
  const [anchor, setAnchor] = useState<AnchorPos | null>(null);

  // 根据 anchorEl 重算 fixed 坐标；anchorEl/expandedIndex/transformEpoch 变化都触发
  useEffect(() => {
    if (!anchorEl) { setAnchor(null); return; }
    const recalc = () => {
      const r = anchorEl.getBoundingClientRect();
      setAnchor(
        computeExpandedAnchor(
          { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
          { w: PANEL_W, h: PANEL_H },
          { w: window.innerWidth, h: window.innerHeight },
          expandedIndex,
        ),
      );
    };
    recalc();
    window.addEventListener('resize', recalc);
    window.addEventListener('scroll', recalc, true);
    return () => {
      window.removeEventListener('resize', recalc);
      window.removeEventListener('scroll', recalc, true);
    };
  }, [anchorEl, expandedIndex, transformEpoch]);

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

  const zIndex = resolveNodeZ({ expanded: true, focused });
  const style: React.CSSProperties | undefined = anchor
    ? { position: 'fixed', left: anchor.left, top: anchor.top, zIndex }
    : { zIndex };

  return (
    <div
      className="canvas-node canvas-node--expanded"
      data-id={id}
      data-instance-id={id}
      data-status={status}
      style={style}
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
