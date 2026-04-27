import type { ReactNode } from 'react';
import './CapsuleWindow.css';

interface CapsuleWindowProps {
  children: ReactNode;
}

export default function CapsuleWindow({ children }: CapsuleWindowProps) {
  return <div className="capsule-window">{children}</div>;
}
