// S4-G1：从 AgentCard 切到 CanvasNode。agents 现在是 CanvasNodeData 形状
// （id/name/status/cliType/isLeader/x/y + taskCount/unreadCount/messageCount）。
// 契约：INTERFACE-CONTRACTS §2 CanvasNodeData / §5.1 CanvasNodeProps。
//
// props 映射：
//   Agent(旧: lastMessage)  → CanvasNodeData(新: taskCount/unreadCount/messageCount)
//   name / status / cliType / x / y / isLeader 直接透传

import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import CanvasNode from '../../molecules/CanvasNode';
import CanvasNodeExpanded from '../../molecules/CanvasNode/CanvasNodeExpanded';
import { useCanvasTransform, type Transform } from '../../hooks/useCanvasTransform';
import { useTentacles } from '../../hooks/useTentacles';
import { useMessageStore } from '../../store/messageStore';
import { selectActiveEdges } from '../../store/selectors/activeEdges';
import type { CanvasNodeData } from '../../types/chat';
import './TeamCanvas.css';

interface TeamCanvasProps {
  agents: CanvasNodeData[];
  initialTransform?: Transform;
  onAgentDragEnd?: (id: string, x: number, y: number) => void;
  onAgentOpen?: (id: string) => void;
  onTransformCommit?: (t: Transform) => void;
  /** 把节点 DOM 元素透出给外层（S5-G1 展开态 fixed 锚点计算用） */
  onNodeElement?: (id: string, el: HTMLElement | null) => void;
  /** S5-G2：传入画布尺寸后 CanvasNode 拖拽越界自动 clamp+回弹 */
  canvasSize?: { width: number; height: number };
  /** 当前展开的节点 id 栈；栈顶为 focused */
  expandedIds?: string[];
  /** 展开态顶栏拖动结束；坐标是 viewport 内 absolute 值 */
  onExpandedDragEnd?: (id: string, x: number, y: number) => void;
  onExpandedMinimize?: (id: string) => void;
  onExpandedClose?: (id: string) => void;
  /** 展开态主区 children（装配 ChatList + InstanceChatPanelConnected 由上层给） */
  renderExpandedBody?: (id: string) => ReactNode;
}

export default function TeamCanvas({
  agents, initialTransform, onAgentDragEnd, onAgentOpen, onTransformCommit,
  onNodeElement, canvasSize,
  expandedIds, onExpandedDragEnd, onExpandedMinimize, onExpandedClose, renderExpandedBody,
}: TeamCanvasProps) {
  const { viewportRef, containerRef, onPanStart, reset, isPanning, getZoom, setTransform } =
    useCanvasTransform({ onTransformCommit });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cardEls = useRef<Map<string, HTMLElement>>(new Map());

  const getCardElement = useCallback((id: string) => cardEls.current.get(id) ?? null, []);

  // S6-G1：每帧从 messageStore 派生 activeEdges；空闲 0 边，有通信时按 intensity 调色。
  const getActiveEdges = useCallback(() => {
    const state = useMessageStore.getState();
    return selectActiveEdges(state, Date.now());
  }, []);

  useTentacles(
    canvasRef,
    agents.map((a) => ({ id: a.id, isLeader: !!a.isLeader })),
    getCardElement,
    getActiveEdges,
  );

  useEffect(() => {
    if (initialTransform) setTransform(initialTransform);
  }, [initialTransform, setTransform]);

  const cls = ['team-canvas'];
  if (isPanning) cls.push('team-canvas--panning');

  const expandedSet = new Set(expandedIds ?? []);
  const topExpanded = expandedIds && expandedIds.length > 0 ? expandedIds[expandedIds.length - 1] : null;

  return (
    <div
      ref={containerRef}
      className={cls.join(' ')}
      onMouseDown={onPanStart}
      onDoubleClick={(e) => { if (e.target === e.currentTarget) reset(); }}
    >
      <canvas ref={canvasRef} className="team-canvas__fx" />
      <div className="team-canvas__viewport" ref={viewportRef}>
        {agents.map((a) => {
          if (expandedSet.has(a.id)) {
            return (
              <CanvasNodeExpanded
                key={a.id}
                id={a.id}
                name={a.name}
                status={a.status}
                x={a.x}
                y={a.y}
                focused={a.id === topExpanded}
                getZoom={getZoom}
                onDragEnd={(x, y) => onExpandedDragEnd?.(a.id, x, y)}
                onMinimize={() => onExpandedMinimize?.(a.id)}
                onClose={() => onExpandedClose?.(a.id)}
              >
                {renderExpandedBody?.(a.id)}
              </CanvasNodeExpanded>
            );
          }
          return (
            <CanvasNode
              key={a.id}
              id={a.id}
              name={a.name}
              status={a.status}
              cliType={a.cliType}
              avatar={a.avatar}
              isLeader={a.isLeader}
              taskCount={a.taskCount}
              unreadCount={a.unreadCount}
              messageCount={a.messageCount}
              x={a.x}
              y={a.y}
              onOpen={onAgentOpen}
              onDragEnd={(x, y) => onAgentDragEnd?.(a.id, x, y)}
              getZoom={getZoom}
              canvasSize={canvasSize}
              elementRef={(el) => {
                if (el) cardEls.current.set(a.id, el);
                else cardEls.current.delete(a.id);
                onNodeElement?.(a.id, el);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
