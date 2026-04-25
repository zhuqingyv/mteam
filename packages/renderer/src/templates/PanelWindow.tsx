import type { ReactNode } from 'react';

interface PanelWindowProps {
  children: ReactNode;
}

export default function PanelWindow({ children }: PanelWindowProps) {
  return (
    <div className="w-screen h-screen overflow-auto bg-[var(--surface-glass-dark)] text-text-primary">
      {children}
    </div>
  );
}
