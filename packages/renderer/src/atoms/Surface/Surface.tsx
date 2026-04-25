import type { ReactNode } from 'react';
import './Surface.css';

interface SurfaceProps {
  variant?: 'capsule' | 'panel';
  children: ReactNode;
  className?: string;
}

export default function Surface({ variant = 'capsule', children, className = '' }: SurfaceProps) {
  return (
    <div className={`surface surface--${variant} ${className}`.trim()}>
      {children}
    </div>
  );
}
