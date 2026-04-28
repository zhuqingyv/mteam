// S4-G1：从 AgentCard 切到 CanvasNode。agents 现在是 CanvasNodeData 形状
// （id/name/status/cliType/isLeader/x/y + taskCount/unreadCount/messageCount）。
// 契约：INTERFACE-CONTRACTS §2 CanvasNodeData / §5.1 CanvasNodeProps。
//
// props 映射：
//   Agent(旧: lastMessage)  → CanvasNodeData(新: taskCount/unreadCount/messageCount)
//   name / status / cliType / x / y / isLeader 直接透传

import { useCallback, useEffect, useRef } from 'react';
import CanvasNode from '../../molecules/CanvasNode';
import { useCanvasTransform, type Transform } from '../../hooks/useCanvasTransform';
import { useTentacles } from '../../hooks/useTentacles';
import type { CanvasNodeData } from '../../types/chat';
import './TeamCanvas.css';

interface TeamCanvasProps {
  agents: CanvasNodeData[];
  initialTransform?: Transform;
  onAgentDragEnd?: (id: string, x: number, y: number) => void;
  onAgentOpen?: (id: string) => void;
  onTransformCommit?: (t: Transform) => void;
}

export default function TeamCanvas({
  agents, initialTransform, onAgentDragEnd, onAgentOpen, onTransformCommit,
}: TeamCanvasProps) {
  const { viewportRef, containerRef, onPanStart, reset, isPanning, getZoom, setTransform } =
    useCanvasTransform({ onTransformCommit });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cardEls = useRef<Map<string, HTMLElement>>(new Map());

  const getCardElement = useCallback((id: string) => cardEls.current.get(id) ?? null, []);

  useTentacles(
    canvasRef,
    agents.map((a) => ({ id: a.id, isLeader: !!a.isLeader })),
    getCardElement,
  );

  useEffect(() => {
    if (initialTransform) setTransform(initialTransform);
  }, [initialTransform, setTransform]);

  const cls = ['team-canvas'];
  if (isPanning) cls.push('team-canvas--panning');

  return (
    <div
      ref={containerRef}
      className={cls.join(' ')}
      onMouseDown={onPanStart}
      onDoubleClick={(e) => { if (e.target === e.currentTarget) reset(); }}
    >
      <canvas ref={canvasRef} className="team-canvas__fx" />
      <div className="team-canvas__viewport" ref={viewportRef}>
        {agents.map((a) => (
          <CanvasNode
            key={a.id}
            id={a.id}
            name={a.name}
            status={a.status}
            cliType={a.cliType}
            isLeader={a.isLeader}
            taskCount={a.taskCount}
            unreadCount={a.unreadCount}
            messageCount={a.messageCount}
            x={a.x}
            y={a.y}
            onOpen={onAgentOpen}
            onDragEnd={(x, y) => onAgentDragEnd?.(a.id, x, y)}
            getZoom={getZoom}
            elementRef={(el) => {
              if (el) cardEls.current.set(a.id, el);
              else cardEls.current.delete(a.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}
