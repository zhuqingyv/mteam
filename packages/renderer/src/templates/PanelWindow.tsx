import type { ReactNode } from 'react';
import DragHandle from '../molecules/DragHandle';
import './PanelWindow.css';

interface PanelWindowProps {
  children: ReactNode;
}

export default function PanelWindow({ children }: PanelWindowProps) {
  return (
    <div className="panel-window">
      <DragHandle />
      {children}
    </div>
  );
}
